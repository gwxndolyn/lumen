import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { conversationDigest } from "../core/chatService";
import { healthStateFor } from "../core/app";
import { OpenAICompatProvider } from "../core/providers/openaiCompat";
import { GeminiProvider } from "../core/providers/gemini";
import { Store } from "../core/storage/db";
import { describeTest } from "../renderer/lib/providerTest";
import type { ChatMessage } from "../shared/types";
import { harness } from "./harness";

const m = (role: "user" | "assistant", content: string): ChatMessage => ({ id: Math.random().toString(36), conversationId: "c", role, content, createdAt: 0, references: [], meta: {} });

describe("provider connection tests report why they failed", () => {
  const resp = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("distinguishes invalid keys, missing models, outages and network failures", async () => {
    const mk = (fetchImpl: typeof fetch) => new OpenAICompatProvider({ flavor: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5", apiKey: "k", supportsImages: true, fetch: fetchImpl });
    expect((await mk(resp(401)).test()).code).toBe("auth");
    expect((await mk(resp(503)).test()).code).toBe("overloaded");
    expect((await mk(resp(429)).test()).code).toBe("rate_limited");
    expect((await mk(resp(200, { data: [{ id: "gpt-4o" }] })).test()).code).toBe("model_unavailable");
    expect((await mk((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch).test()).code).toBe("network");
    const ok = await mk(resp(200, { data: [{ id: "gpt-5" }] })).test();
    expect(ok).toMatchObject({ ok: true });
    expect(ok.code).toBeUndefined();
  });

  it("maps Gemini key rejection to an auth failure", async () => {
    const g = new GeminiProvider({ apiKey: "bad", model: "gemini-2.5-flash", fetch: resp(400, { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }) });
    expect((await g.test()).code).toBe("auth");
  });

  it("marks credential problems as down and transient problems as degraded", () => {
    expect(healthStateFor("auth")).toBe("down");
    expect(healthStateFor("model_unavailable")).toBe("down");
    expect(healthStateFor("network")).toBe("degraded");
    expect(healthStateFor("overloaded")).toBe("degraded");
  });

  it("gives the user a specific next step", () => {
    expect(describeTest({ ok: false, message: "rejected", latencyMs: null, code: "auth" })).toMatchObject({ title: "Invalid key", next: expect.stringMatching(/key/) });
    expect(describeTest({ ok: false, message: "x", latencyMs: null, code: "network" }).next).toMatch(/internet/);
    expect(describeTest({ ok: true, message: "Connected to m.", latencyMs: 42 }).detail).toBe("Connected to m. (42 ms)");
  });

  it("reports missing credentials from the app without a network call", async () => {
    const h = harness({ provider: "none" });
    const r = await h.core.testProvider();
    expect(r).toMatchObject({ ok: false, code: "missing_credentials" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("long-conversation memory", () => {
  it("digests earlier turns compactly with the language of any code", () => {
    const d = conversationDigest([m("user", "Reverse a linked list"), m("assistant", "Use three pointers.\n```java\nNode prev = null;\n```"), m("user", "Now detect a cycle")]);
    expect(d).toContain("Q: Reverse a linked list");
    expect(d).toContain("A: Use three pointers. (included java code)");
    expect(d).toContain("Q: Now detect a cycle");
    const long = conversationDigest(Array.from({ length: 200 }, (_, i) => m(i % 2 ? "assistant" : "user", `message ${i} `.repeat(20))), 500);
    expect(long.length).toBeLessThanOrEqual(502);
    expect(long).toContain("message 198");
  });

  it("sends the digest for follow-ups once the conversation exceeds the history window", async () => {
    const h = harness({ turns: [{ text: ["ok"] }] });
    let conversationId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const ev = await h.ask(i === 0 ? "How does a binary heap work?" : `Heap question number ${i} about sift down`, { conversationId });
      const s = ev.find((e) => e.type === "start");
      if (s?.type === "start") conversationId = s.conversationId;
    }
    await h.ask("What about the space complexity of it?", { conversationId });
    const body = JSON.stringify(h.calls.at(-1)!.body);
    expect(body).toContain("Earlier in this conversation");
    expect(body).toContain("How does a binary heap work?");
  });

  it("does not inject earlier turns when the subject changes", async () => {
    const h = harness({ turns: [{ text: ["ok"] }] });
    let conversationId: string | null = null;
    for (let i = 0; i < 8; i++) {
      const ev = await h.ask(i === 0 ? "How does a binary heap work?" : `Heap question number ${i} about sift down`, { conversationId });
      const s = ev.find((e) => e.type === "start");
      if (s?.type === "start") conversationId = s.conversationId;
    }
    await h.ask("Recommend a good espresso grinder for beginners", { conversationId });
    const body = JSON.stringify(h.calls.at(-1)!.body);
    expect(body).not.toContain("Earlier in this conversation");
    expect(body).not.toContain("How does a binary heap work?");
  });
});

describe("streaming failures", () => {
  it("keeps already-streamed text when the connection drops, marked incomplete and excluded from history", async () => {
    const h = harness({ turns: [{ text: ["The first half ", "of the answer ", "never arrives"], dropAfter: 2 }, { text: ["fresh"] }] });
    const ev = await h.ask("Explain consistent hashing");
    expect(ev.some((e) => e.type === "error")).toBe(true);
    const start = ev.find((e) => e.type === "start");
    const cid = start?.type === "start" ? start.conversationId : "";
    const kept = h.store.listMessages(cid).find((x) => x.role === "assistant");
    expect(kept?.meta.interrupted).toBe(true);
    expect(kept?.content).toContain("The first half");
    await h.ask("Explain it again", { conversationId: cid });
    expect(JSON.stringify((h.calls.at(-1)!.body as { messages: unknown }).messages)).not.toContain("The first half");
  });

  it("records per-stage latency for every request", async () => {
    const h = harness({ turns: [{ text: ["ok"] }] });
    await h.ask("What is a mutex?");
    const r = h.core.metrics.snapshot().requests[0]!;
    expect(r.requestSentMs).toBeGreaterThanOrEqual(0);
    expect(r.pendingWaitMs).toBeGreaterThanOrEqual(0);
    expect(r.ttftMs).not.toBeNull();
    expect(r.totalMs).toBeGreaterThanOrEqual(r.ttftMs!);
  });
});

describe("lifecycle cleanup", () => {
  it("stops transcription, question detection and live screen on shutdown", async () => {
    const h = harness();
    h.core.createSession({ title: "Practice", type: "interview" });
    const live = h.core.startTranscript("Practice");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("Tell me about a project you are proud of?", true, 0, 0);
    expect(h.core.detectorRunning).toBe(true);
    await h.core.shutdown(200);
    expect(live.status).toBe("stopped");
    expect(h.core.detectorRunning).toBe(false);
    expect(h.app.some((e) => e.type === "audio-command" && e.command === "stop")).toBe(true);
  });

  it("deleting the recording session stops capture and forgets its detected questions", () => {
    const h = harness();
    const s = h.core.createSession({ title: "Practice", type: "interview" });
    const live = h.core.startTranscript("Practice");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("Tell me about a project you are proud of?", true, 0, 0);
    h.core.pollQuestions(true);
    expect(h.core.copilot.questions.length).toBe(1);
    h.core.deleteSession(s.id);
    expect(live.status).toBe("stopped");
    expect(h.core.detectorRunning).toBe(false);
    expect(h.core.copilot.questions).toHaveLength(0);
  });
});

describe("restart recovery", () => {
  it("restores sessions, conversations and messages from disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-restart-"));
    const file = path.join(dir, "lumen.db");
    const a = new Store(file);
    const s = a.createSession({ title: "Kept", type: "general" });
    const c = a.createConversation(s.id, "Heap", "general");
    a.addMessage({ conversationId: c.id, role: "user", content: "What is a heap?", references: [], meta: {} });
    a.addMessage({ conversationId: c.id, role: "assistant", content: "A tree-shaped priority queue.", references: [], meta: { intent: { relation: "new", category: "algorithm", depth: "quick", label: "New question · Algorithm · Quick" } } });
    a.setLastConversation(s.id, c.id);
    a.close();
    const b = new Store(file);
    expect(b.getSession(s.id)?.title).toBe("Kept");
    expect(b.getLastConversation(s.id)).toBe(c.id);
    const msgs = b.listMessages(c.id);
    expect(msgs.map((x) => x.content)).toEqual(["What is a heap?", "A tree-shaped priority queue."]);
    expect(msgs[1]!.meta.intent?.category).toBe("algorithm");
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
