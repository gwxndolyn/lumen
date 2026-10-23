// Hybrid inference: Ollama adapter over its real wire format, routing and privacy enforcement,
// fallback rules, budgets, concurrency, timeouts, the response cache and local embeddings.
import { describe, expect, it } from "vitest";
import { decideRoute, protectedKindsOf, type Availability, type HybridPolicy, type RouteRequest } from "../core/inference/hybrid";
import { LruCache, responseKey } from "../core/inference/cache";
import { cosine, EmbeddingIndex, mergeHits } from "../core/inference/embeddings";
import { OllamaProvider, OllamaRuntime, isLoopbackUrl } from "../core/providers/ollama";
import { ProviderError } from "../core/providers/types";
import { Store } from "../core/storage/db";
import { addKnowledgeText } from "../core/knowledge";
import { harness } from "./harness";
import { BENCHMARK } from "../core/eval/benchmark";
import { runEvaluation } from "../core/eval/runner";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { applySettingsPatch } from "../shared/settingsSchema";
import { sentText } from "./helpers";

// ---------- a fake Ollama runtime speaking the native API (NDJSON streaming) ----------
interface FakeOllama {
  models?: { name: string; caps?: string[]; ctx?: number }[];
  down?: boolean;
  answer?: (body: Record<string, unknown>) => string;
  chatStatus?: number;
  chatError?: string;
  stallMs?: number;
  embedDims?: number;
}
function fakeOllama(o: FakeOllama = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const models = o.models ?? [{ name: "llama3.2:latest", caps: ["completion"], ctx: 8192 }];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, body });
    if (o.down) throw new TypeError("fetch failed");
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/api/version":
        return json({ version: "0.12.0" });
      case "/api/tags":
        return json({ models: models.map((m) => ({ name: m.name, size: 2_000_000_000, details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" } })) });
      case "/api/show": {
        const m = models.find((x) => x.name === body.model || x.name === `${String(body.model)}:latest`);
        if (!m) return json({ error: `model '${String(body.model)}' not found` }, 404);
        return json({ capabilities: m.caps ?? ["completion"], model_info: { "llama.context_length": m.ctx ?? 8192 }, details: {} });
      }
      case "/api/embed": {
        const texts = body.input as string[];
        const d = o.embedDims ?? 4;
        // Deterministic toy vectors: letter-frequency over a few letters.
        return json({ model: body.model, embeddings: texts.map((t) => Array.from({ length: d }, (_, i) => t.toLowerCase().split("aeio"[i % 4]!).length - 1 + 0.01)) });
      }
      case "/api/chat": {
        if (o.chatStatus) return json({ error: o.chatError ?? "boom" }, o.chatStatus);
        const text = o.answer?.(body) ?? "Local answer.";
        const enc = new TextEncoder();
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            if (o.stallMs) {
              await new Promise((r) => setTimeout(r, o.stallMs));
              if (signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
            }
            for (const piece of text.match(/.{1,8}/gs) ?? []) c.enqueue(enc.encode(JSON.stringify({ message: { role: "assistant", content: piece }, done: false }) + "\n"));
            c.enqueue(enc.encode(JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 321, eval_count: 12 }) + "\n"));
            c.close();
          },
        });
        signal?.addEventListener("abort", () => stream.cancel().catch(() => undefined));
        return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      }
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const POLICY: HybridPolicy = { mode: "manual", privacyRestricted: false, cloudAllowed: { screen: false, transcript: false, documents: false }, fallback: { cloudToLocal: true, localToCloud: false } };
const REQ: RouteRequest = { protectedKinds: [], needsVision: false, estimatedTokens: 1000, category: "general", depth: "quick" };
const AV: Availability = {
  selectedKind: "anthropic",
  cloud: { ready: true, vision: true, contextTokens: 200_000, label: "Claude" },
  local: { ready: true, vision: false, contextTokens: 8192, label: "llama3.2 (local)" },
};

describe("Ollama adapter (native API)", () => {
  it("only accepts loopback endpoints", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434")).toBe(false);
    expect(isLoopbackUrl("http://ollama.example.com")).toBe(false);
    expect(() => new OllamaRuntime("http://10.0.0.2:11434")).toThrow(/this computer/);
  });

  it("discovers installed models and capabilities", async () => {
    const f = fakeOllama({
      models: [
        { name: "llava:latest", caps: ["completion", "vision"], ctx: 4096 },
        { name: "nomic-embed-text:latest", caps: ["embedding"] },
      ],
    });
    const rt = new OllamaRuntime("http://127.0.0.1:11434", { fetch: f.fetch });
    const st = await rt.status();
    expect(st).toMatchObject({ available: true, version: "0.12.0" });
    expect(st.models.map((m) => m.name)).toEqual(["llava:latest", "nomic-embed-text:latest"]);
    expect(await rt.show("llava")).toMatchObject({ capabilities: ["completion", "vision"], contextLength: 4096 });
  });

  it("reports a missing runtime without throwing", async () => {
    const rt = new OllamaRuntime("http://127.0.0.1:11434", { fetch: fakeOllama({ down: true }).fetch });
    const st = await rt.status();
    expect(st.available).toBe(false);
    expect(st.error).toMatch(/not running/);
  });

  it("streams an answer, sets num_ctx and reports usage", async () => {
    const f = fakeOllama({ answer: () => "Hello from the local model." });
    const p = new OllamaProvider({
      model: "llama3.2",
      numCtx: 8192,
      details: { name: "llama3.2", sizeBytes: 0, family: null, parameterSize: null, quantization: null, capabilities: ["completion"], contextLength: 8192 },
      fetch: f.fetch,
    });
    const deltas: string[] = [];
    const r = await p.generate(
      { model: "llama3.2", system: [{ text: "sys", cache: true }], messages: [{ role: "user", content: "hi" }], maxTokens: 500, effort: "low", timeoutMs: 5000 },
      new AbortController().signal,
      { onDelta: (d) => deltas.push(d) },
    );
    expect(r.text).toBe("Hello from the local model.");
    expect(deltas.length).toBeGreaterThan(1);
    expect(r.usage).toMatchObject({ inputTokens: 321, outputTokens: 12 });
    const body = f.calls.find((c) => c.path === "/api/chat")!.body as { options: { num_ctx: number }; messages: { role: string }[] };
    expect(body.options.num_ctx).toBe(8192);
    expect(body.messages[0]!.role).toBe("system");
    expect(p.capabilities).toMatchObject({ location: "local", vision: false, contextTokens: 8192 });
  });

  it("refuses a request that does not fit instead of letting the runtime truncate the policy", async () => {
    const p = new OllamaProvider({ model: "m", numCtx: 2048, fetch: fakeOllama().fetch });
    await expect(
      p.generate(
        { model: "m", system: [{ text: "s", cache: false }], messages: [{ role: "user", content: "x".repeat(20_000) }], maxTokens: 500, effort: "low", timeoutMs: 5000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "context_too_large" });
  });

  it("maps a missing model and out-of-memory to clear, non-retryable errors", async () => {
    const missing = new OllamaProvider({ model: "nope", numCtx: 4096, fetch: fakeOllama({ chatStatus: 404, chatError: "model 'nope' not found, try pulling it first" }).fetch });
    const req = { model: "nope", system: [], messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100, effort: "low" as const, timeoutMs: 5000 };
    await expect(missing.generate(req, new AbortController().signal)).rejects.toMatchObject({ code: "bad_request", retryable: false, message: expect.stringMatching(/ollama pull nope/) });
    const oom = new OllamaProvider({ model: "big", numCtx: 4096, fetch: fakeOllama({ chatStatus: 500, chatError: "model requires more system memory (20 GiB) than is available" }).fetch });
    await expect(oom.generate({ ...req, model: "big" }, new AbortController().signal)).rejects.toMatchObject({ code: "overloaded", message: expect.stringMatching(/enough memory/) });
  });

  it("times out a model that never starts, without retrying", async () => {
    const f = fakeOllama({ stallMs: 2000 });
    const p = new OllamaProvider({ model: "m", numCtx: 4096, fetch: f.fetch });
    await expect(
      p.generate({ model: "m", system: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "low", timeoutMs: 150, idleTimeoutMs: 150 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "timeout", retryable: false });
    expect(f.calls.filter((c) => c.path === "/api/chat")).toHaveLength(1);
  });

  it("cancellation propagates", async () => {
    const p = new OllamaProvider({ model: "m", numCtx: 4096, fetch: fakeOllama({ stallMs: 500 }).fetch });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await expect(p.generate({ model: "m", system: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "low", timeoutMs: 5000 }, ctrl.signal)).rejects.toMatchObject({
      name: "CancelledError",
    });
  });

  it("test() says how to install a missing model and never installs it", async () => {
    const f = fakeOllama({ models: [] });
    const r = await new OllamaProvider({ model: "llama3.2", numCtx: 4096, fetch: f.fetch }).test();
    expect(r).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(r.message).toMatch(/ollama pull llama3.2/);
    expect(f.calls.some((c) => c.path === "/api/pull")).toBe(false);
  });
});

describe("routing policy", () => {
  it("manual uses exactly the selected provider", () => {
    expect(decideRoute(POLICY, REQ, AV)).toMatchObject({ route: "cloud", fallback: null, leavesDevice: true });
    expect(decideRoute(POLICY, REQ, { ...AV, selectedKind: "ollama" })).toMatchObject({ route: "local", fallback: null, leavesDevice: false });
  });

  it("privacy restriction blocks protected context from the cloud, even in manual mode", () => {
    const p = { ...POLICY, privacyRestricted: true };
    const r = decideRoute(p, { ...REQ, protectedKinds: ["screen"] }, AV);
    expect(r.route).toBeNull();
    expect(r.reason).toMatch(/screen content on this device/);
    expect(r.alternatives.join(" ")).toMatch(/allow sending/i);
    // Allowed kind passes.
    expect(decideRoute({ ...p, cloudAllowed: { ...p.cloudAllowed, screen: true } }, { ...REQ, protectedKinds: ["screen"] }, AV).route).toBe("cloud");
    // No protected content → cloud is fine.
    expect(decideRoute(p, REQ, AV).route).toBe("cloud");
  });

  it("cloud first moves protected context to the local model instead of the cloud", () => {
    const r = decideRoute({ ...POLICY, mode: "cloud_first", privacyRestricted: true }, { ...REQ, protectedKinds: ["transcript"] }, AV);
    expect(r).toMatchObject({ route: "local", leavesDevice: false });
    // And never offers the cloud as a fallback for it.
    expect(r.fallback).toBeNull();
  });

  it("local failure never falls back to the cloud unless the user allowed it", () => {
    const lf = { ...POLICY, mode: "local_first" as const };
    expect(decideRoute(lf, REQ, AV)).toMatchObject({ route: "local", fallback: null });
    expect(decideRoute({ ...lf, fallback: { cloudToLocal: true, localToCloud: true } }, REQ, AV)).toMatchObject({ route: "local", fallback: "cloud" });
    // Allowed by setting but blocked by privacy → still no cloud fallback.
    expect(decideRoute({ ...lf, privacyRestricted: true, fallback: { cloudToLocal: true, localToCloud: true } }, { ...REQ, protectedKinds: ["documents"] }, AV).fallback).toBeNull();
  });

  it("local first sends deep coding work to the cloud and respects capability limits", () => {
    const lf = { ...POLICY, mode: "local_first" as const };
    expect(decideRoute(lf, { ...REQ, category: "algorithm", depth: "deep" }, AV).route).toBe("cloud");
    expect(decideRoute(lf, { ...REQ, needsVision: true }, AV).route).toBe("cloud");
    expect(decideRoute(lf, { ...REQ, estimatedTokens: 50_000 }, AV).route).toBe("cloud");
  });

  it("explains when nothing can take the request", () => {
    const r = decideRoute({ ...POLICY, mode: "local_first" }, REQ, { ...AV, cloud: { ...AV.cloud, ready: false }, local: { ...AV.local, ready: false, reason: "Ollama is not running" } });
    expect(r.route).toBeNull();
    expect(r.reason).toMatch(/Ollama is not running/);
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it("classifies protected context kinds", () => {
    expect(protectedKindsOf(["ocr", "note", "transcript", "knowledge"]).sort()).toEqual(["documents", "screen", "transcript"]);
    expect(protectedKindsOf(["note", "history", "memory"])).toEqual([]);
  });
});

describe("end to end through AppCore", () => {
  const local = (o: FakeOllama = {}, settings: Record<string, unknown> = {}) => {
    const f = fakeOllama(o);
    const h = harness({ settings: { inference: { local: { model: "llama3.2" } }, ...settings }, localFetch: f.fetch });
    return { h, f };
  };

  it("manual local: answers on the device and records zero cost with basis 'local'", async () => {
    const { h, f } = local({ answer: () => "On-device answer." }, { provider: { kind: "ollama" } });
    const evts = await h.ask("Hello there");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
    expect(evts.find((e) => e.type === "start")).toMatchObject({ provider: { kind: "ollama", model: "llama3.2" }, routing: { route: "local", leavesDevice: false } });
    expect(h.calls).toHaveLength(0); // the cloud was never contacted
    expect(f.calls.some((c) => c.path === "/api/chat")).toBe(true);
    expect(h.core.usage.report()).toEqual([expect.objectContaining({ provider: "ollama", costBasis: "local", inputTokens: 321, costUsd: 0 })]);
  });

  it("privacy restricted: screen text never reaches the cloud; it is answered locally", async () => {
    const { h, f } = local({}, { inference: { mode: "cloud_first", privacyRestricted: true, local: { model: "llama3.2" } } });
    await h.capture("Payroll").ocr; // FakeOcr recognises "Invoice 4471 total due…"
    const evts = await h.ask("What does my screen say?");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
    expect(h.calls).toHaveLength(0);
    expect(JSON.stringify(f.calls.find((c) => c.path === "/api/chat")!.body)).toContain("Invoice 4471");
  });

  it("privacy restricted with no local model: refuses with alternatives and sends nothing", async () => {
    const { h } = local({ down: true }, { inference: { mode: "cloud_first", privacyRestricted: true, local: { model: "llama3.2" } } });
    h.core.addText("document", "Contract", "Confidential contract terms: fee 12%.");
    const evts = await h.ask("Summarise the contract terms");
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "routing_blocked" });
    expect((evts.at(-1) as { message: string }).message).toMatch(/documents on this device/);
    expect(h.calls).toHaveLength(0);
  });

  it("a local failure does not leak to the cloud by default", async () => {
    const { h } = local({ chatStatus: 500, chatError: "crash" }, { inference: { mode: "local_first", local: { model: "llama3.2" } } });
    const evts = await h.ask("Hello there");
    expect(evts.at(-1)).toMatchObject({ type: "error" });
    expect(h.calls).toHaveLength(0);
  });

  it("cloud failure falls back to the local model when allowed (data stays on device)", async () => {
    const f = fakeOllama({ answer: () => "Local fallback answer." });
    const h = harness({
      settings: { inference: { mode: "cloud_first", local: { model: "llama3.2" } } },
      localFetch: f.fetch,
      turns: [{ status: 401, error: { type: "authentication_error", message: "bad key" } }],
    });
    const evts = await h.ask("Hello there");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
    expect(evts.some((e) => e.type === "retrying" && /local model on this device/.test(e.reason))).toBe(true);
    const saved = h.store.listMessages(h.store.listConversations(h.core.activeSessionId)[0]!.id).at(-1)!;
    expect(saved.meta).toMatchObject({ route: "local", fellBack: true });
  });

  it("local model with a small context: too-large requests go to the cloud in local-first, never truncated", async () => {
    const { h } = local({ models: [{ name: "llama3.2:latest", ctx: 2048 }] }, { inference: { mode: "local_first", local: { model: "llama3.2", numCtx: 2048 } } });
    h.core.addText("note", "Big", "notes ".repeat(4000));
    const evts = await h.ask("Summarise my notes");
    expect(evts.find((e) => e.type === "start")).toMatchObject({ routing: { route: "cloud" } });
  });
});

describe("limits", () => {
  it("per-session request limit", async () => {
    const h = harness({ settings: { limits: { requestsPerSession: 1 } }, turns: [{ text: ["one"] }, { text: ["two"] }] });
    expect((await h.ask("First")).at(-1)).toMatchObject({ type: "done" });
    const second = await h.ask("Second");
    expect(second.at(-1)).toMatchObject({ type: "error", code: "spend_limit" });
    expect(h.calls).toHaveLength(1);
  });

  it("per-session cost limit uses the worst-case estimate before sending", async () => {
    const h = harness({ settings: { limits: { costPerSessionUsd: 0.01 }, provider: { maxTokens: 16000 } } });
    const evts = await h.ask("Hello");
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "spend_limit" });
    expect((evts.at(-1) as { message: string }).message).toMatch(/could cost up to/);
    expect(h.calls).toHaveLength(0);
  });

  it("budget warnings appear at the configured threshold", () => {
    const h = harness({ settings: { provider: { dailySpendLimitUsd: 1 }, limits: { warnAtPercent: 50 } } });
    h.store.recordUsage("claude-opus-5-5", 1, 1, 0.6, Date.now(), { sessionId: h.core.activeSessionId, provider: "anthropic" });
    expect(h.core.usage.status(h.core.activeSessionId).warnings.join(" ")).toMatch(/daily limit/);
  });

  it("concurrency limit", async () => {
    const h = harness({ settings: { limits: { maxConcurrentRequests: 1 } }, turns: [{ text: ["a", "b", "c"], delayMs: 30 }] });
    const sid = h.core.activeSessionId;
    const c2 = h.store.createConversation(sid, "two", "general");
    const p1 = h.ask("One");
    const r2 = await h.ask("Two", { conversationId: c2.id });
    expect(r2.at(-1)).toMatchObject({ type: "error", code: "busy" });
    expect((await p1).at(-1)).toMatchObject({ type: "done" });
  });

  it("max attempts caps retries", async () => {
    const h = harness({ settings: { limits: { maxAttempts: 1 } }, turns: [{ status: 529, error: { type: "overloaded_error", message: "x" } }, { text: ["ok"] }] });
    const evts = await h.ask("Hello");
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "overloaded" });
    expect(h.calls).toHaveLength(1);
  });

  it("failed attempts are recorded, so failure rates are real", async () => {
    const h = harness({ turns: [{ status: 401, error: { type: "authentication_error", message: "bad" } }] });
    await h.ask("Hello");
    expect(h.core.usage.report()).toEqual([expect.objectContaining({ outcome: "error", requests: 1, costUsd: 0 })]);
  });

  it("models without a price are recorded with cost basis 'none', not as free list price", async () => {
    const h = harness({ settings: { provider: { kind: "openai" } }, secrets: { openai: "sk-test" } });
    expect(h.core.usage).toBeDefined();
    const { costFor } = await import("../core/inference/usage");
    expect(costFor("openai", "gpt-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, h.settings)).toEqual({ usd: 0, basis: "none" });
    expect(costFor("anthropic", "claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, h.settings)).toEqual({ usd: 4, basis: "list_price" });
  });
});

describe("response cache", () => {
  it("is off by default", async () => {
    const h = harness({ settings: { assistant: { useConversationHistory: false } }, turns: [{ text: ["A1"] }, { text: ["A2"] }] });
    await h.ask("Same question");
    await h.ask("Same question");
    expect(h.calls).toHaveLength(2);
  });

  it("when enabled, reuses only an identical request and invalidates when context changes", async () => {
    // History retrieval is off so the second ask has identical context (with it on, the first
    // answer becomes context and the request legitimately differs — a miss).
    const h = harness({ settings: { inference: { responseCache: true }, assistant: { useConversationHistory: false } }, turns: [{ text: ["A1"] }, { text: ["A2"] }, { text: ["A3"] }] });
    const a = await h.ask("Same question");
    const b = await h.ask("Same question");
    expect(h.calls).toHaveLength(1);
    expect(b.find((e) => e.type === "done")).toMatchObject({ cached: true });
    expect(
      a
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("A1");
    h.core.addText("note", "New fact", "The launch moved to Friday.");
    await h.ask("Same question");
    expect(h.calls).toHaveLength(2);
    expect(sentText(h.calls[1]!.body)).toContain("launch moved");
    expect(h.core.responseCache.stats()).toMatchObject({ hits: 1 });
  });

  it("LRU bounds, TTL, tag invalidation and keys over every input", () => {
    let t = 0;
    const c = new LruCache<string>({ maxEntries: 2, maxBytes: 100, ttlMs: 1000, size: (v) => v.length }, () => t);
    c.set("a", "1", { tag: "s1" });
    c.set("b", "2", { tag: "s2" });
    c.set("c", "3", { tag: "s1" });
    expect(c.get("a")).toBeUndefined();
    expect(c.stats().evictions).toBe(1);
    expect(c.invalidateTag("s1")).toBe(1);
    t = 2000;
    expect(c.get("b")).toBeUndefined();
    c.set("big", "x".repeat(200));
    expect(c.get("big")).toBeUndefined();
    const base = { kind: "anthropic", model: "m", system: ["s"], messages: [{ role: "user", content: "q" }], maxTokens: 10, effort: "low" };
    expect(responseKey(base)).not.toBe(responseKey({ ...base, model: "m2" }));
    expect(responseKey(base)).not.toBe(responseKey({ ...base, system: ["s2"] }));
  });
});

describe("local embeddings", () => {
  const setup = (dims = 4) => {
    const store = new Store(":memory:");
    const f = fakeOllama({ models: [{ name: "nomic-embed-text:latest", caps: ["embedding"] }, { name: "llama3.2:latest" }], embedDims: dims });
    const rt = new OllamaRuntime("http://127.0.0.1:11434", { fetch: f.fetch });
    return { store, f, idx: new EmbeddingIndex(store, () => rt), rt };
  };

  it("builds only on request, validates the model and searches by similarity", async () => {
    const { store, idx, f } = setup();
    addKnowledgeText(store, "Pets", "A cat sat on a mat.", null);
    addKnowledgeText(store, "Ops", "Deploy on Tuesday.", null);
    expect(f.calls.some((c) => c.path === "/api/embed")).toBe(false);
    await expect(idx.build("llama3.2")).rejects.toThrow(/not an embedding model/);
    expect(await idx.build("nomic-embed-text")).toBe(2);
    expect(idx.state("nomic-embed-text")).toMatchObject({ indexed: 2, totalChunks: 2, dims: 4, stale: false });
    const hits = await idx.search("nomic-embed-text", "cat mat", null);
    expect(hits?.length).toBeGreaterThan(0);
  });

  it("never mixes embedding spaces; a different model marks the index stale and search falls back", async () => {
    const { store, idx } = setup();
    addKnowledgeText(store, "Pets", "A cat sat on a mat.", null);
    await idx.build("nomic-embed-text");
    expect(idx.state("other-embed").stale).toBe(true);
    expect(await idx.search("other-embed", "cat", null)).toBeNull();
    expect(() => store.saveEmbeddings("other-embed", [{ chunkId: "x", vector: new Float32Array(4) }])).toThrow(/different model/);
    expect(() => store.saveEmbeddings("nomic-embed-text", [{ chunkId: "x", vector: new Float32Array(8) }])).toThrow(/different model/);
  });

  it("vectors are deleted with their document and with Delete everything", async () => {
    const { store, idx } = setup();
    const doc = addKnowledgeText(store, "Pets", "A cat sat on a mat.", null);
    await idx.build("nomic-embed-text");
    store.deleteKnowledgeDoc(doc.id);
    expect(idx.state("nomic-embed-text").indexed).toBe(0);
    addKnowledgeText(store, "Ops", "Deploy on Tuesday.", null);
    await idx.build("nomic-embed-text");
    store.deleteAll();
    expect(store.embeddingIndexInfo()).toEqual([]);
  });

  it("keyword search remains the fallback and merging de-duplicates", () => {
    const k = [{ docId: "d", chunkId: "1", title: "t", text: "x", snippet: "x", sessionId: null }];
    expect(mergeHits(k, null)).toEqual(k);
    expect(mergeHits(k, [...k, { ...k[0]!, chunkId: "2" }]).map((h) => h.chunkId)).toEqual(["1", "2"]);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
  });
});

describe("local model in the Evaluation Lab", () => {
  it("measures the local model, records hardware and memory, and reports zero API cost", async () => {
    const f = fakeOllama({ answer: () => "Return **201 Created**." });
    const settings = applySettingsPatch(DEFAULT_SETTINGS, { provider: { kind: "ollama" }, inference: { local: { model: "llama3.2" } } });
    const lp = new OllamaProvider({ model: "llama3.2", numCtx: 8192, fetch: f.fetch });
    const run = await runEvaluation({
      mode: "live",
      cases: [BENCHMARK.find((c) => c.id === "fact-001")!],
      benchmarkVersion: "x",
      settings,
      liveProvider: () => lp,
      describeLocal: async () => ({ runtimeVersion: "0.12.0", loaded: [{ name: "llama3.2:latest", sizeBytes: 3e9, vramBytes: 0 }] }),
    });
    expect(run.results[0]).toMatchObject({ status: "passed", model: "llama3.2", usage: { inputTokens: 321, outputTokens: 12 } });
    expect(run.config).toMatchObject({ provider: "ollama", model: "llama3.2" });
    expect(run.environment).toMatchObject({ location: "local", runtimeVersion: "0.12.0", loadedModels: [{ name: "llama3.2:latest" }] });
    expect(run.environment!.memoryGb).toBeGreaterThan(0);
    expect(run.summary.usage.costUsd).toBe(0);
    expect(run.limitations.join(" ")).toMatch(/hardware/);
    expect(f.calls.some((c) => c.path === "/api/chat")).toBe(true);
  });

  it("the user's privacy restriction does not change which model a benchmark measures", async () => {
    const settings = applySettingsPatch(DEFAULT_SETTINGS, { inference: { privacyRestricted: true, mode: "local_first" } });
    const run = await runEvaluation({ mode: "deterministic", cases: BENCHMARK.filter((c) => c.category === "context_retrieval"), benchmarkVersion: "x", settings });
    expect(run.summary.counts.failed + run.summary.counts.inconclusive).toBe(0);
  });
});

describe("errors keep their meaning", () => {
  it("a ProviderError from routing is not retryable", () => {
    expect(new ProviderError("x", "routing_blocked", false).retryable).toBe(false);
  });
});
