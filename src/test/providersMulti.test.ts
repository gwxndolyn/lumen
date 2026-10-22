// OpenAI and Gemini providers against wire-format fakes (official REST shapes).
import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../core/providers/gemini";
import { OpenAICompatProvider } from "../core/providers/openaiCompat";
import { CancelledError, ProviderError, type GenerateRequest } from "../core/providers/types";
import { activeModel, DEFAULT_SETTINGS } from "../shared/defaults";
import { noSleep } from "./helpers";
import { harness } from "./harness";

const req: GenerateRequest = {
  model: "ignored",
  system: [{ text: "policy", cache: true }, { text: "mode", cache: false }],
  messages: [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "reply" },
    { role: "user", content: [{ type: "image", mediaType: "image/jpeg", data: "SU1H" }, { type: "text", text: "what is this?" }] },
  ],
  maxTokens: 500,
  effort: "low",
  timeoutMs: 5000,
};

const sse = (lines: unknown[], delay = 0) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const l of lines) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          c.enqueue(enc.encode(`data: ${JSON.stringify(l)}\r\n\r\n`));
        }
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

describe("OpenAI provider", () => {
  it("targets api.openai.com with max_completion_tokens, Bearer auth and image_url parts", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new OpenAICompatProvider({
      flavor: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5",
      apiKey: "sk-test-openai",
      supportsImages: true,
      retry: noSleep,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sse([{ choices: [{ delta: { content: "It is " } }] }, { choices: [{ delta: { content: "a chart." }, finish_reason: "length" }], usage: { prompt_tokens: 11, completion_tokens: 4 } }]);
      }) as unknown as typeof fetch,
    });
    const r = await p.generate(req, new AbortController().signal);
    expect(r).toMatchObject({ text: "It is a chart.", stopReason: "max_tokens", usage: { inputTokens: 11, outputTokens: 4 } });
    expect(p.kind).toBe("openai");
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe("Bearer sk-test-openai");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages.at(-1).content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,SU1H" } });
  });
});

describe("Gemini provider", () => {
  it("streams via SSE, maps roles and images, sends the key only in a header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const p = new GeminiProvider({
      apiKey: "AIzaTESTKEY",
      model: "gemini-2.5-flash",
      retry: noSleep,
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return sse([
          { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }] } }] },
          { candidates: [{ content: { parts: [{ text: "A bar " }] } }] },
          { candidates: [{ content: { parts: [{ text: "chart." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
        ]);
      }) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const r = await p.generate(req, new AbortController().signal, { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["A bar ", "chart."]); // thought parts are not shown as answer text
    expect(r).toMatchObject({ text: "A bar chart.", stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5 } });
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(seen[0]!.url).not.toContain("AIza");
    expect(new Headers(seen[0]!.init.headers).get("x-goog-api-key")).toBe("AIzaTESTKEY");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("policy\n\nmode");
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[2].parts[0]).toEqual({ inline_data: { mime_type: "image/jpeg", data: "SU1H" } });
    expect(body.generationConfig.maxOutputTokens).toBe(500);
  });

  it("maps errors: invalid key, quota (retried), safety block, network", async () => {
    const mk = (fn: () => Response | Promise<Response>) => new GeminiProvider({ apiKey: "k", model: "m", retry: noSleep, fetch: (async () => fn()) as unknown as typeof fetch });
    const bad = (await mk(() => Response.json({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 })).generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(bad.code).toBe("auth");
    let n = 0;
    const quota = await mk(() => (n++ === 0 ? new Response("{}", { status: 429 }) : sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]))).generate(req, new AbortController().signal);
    expect(quota).toMatchObject({ text: "ok", retries: 1 });
    const blocked = (await mk(() => sse([{ promptFeedback: { blockReason: "SAFETY" } }])).generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(blocked.code).toBe("refusal");
    const down = (await mk(() => {
      throw new TypeError("fetch failed");
    }).generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(down.code).toBe("network");
  });

  it("cancels mid-stream", async () => {
    const p = new GeminiProvider({
      apiKey: "k",
      model: "m",
      retry: noSleep,
      fetch: (async () => sse(Array.from({ length: 40 }, () => ({ candidates: [{ content: { parts: [{ text: "x" }] } }] })), 5)) as unknown as typeof fetch,
    });
    const ctrl = new AbortController();
    let n = 0;
    await expect(p.generate(req, ctrl.signal, { onDelta: () => ++n === 3 && ctrl.abort() })).rejects.toBeInstanceOf(CancelledError);
  });

  it("health check verifies the model is available to the key", async () => {
    const p = new GeminiProvider({ apiKey: "k", model: "gemini-2.5-flash", fetch: (async () => Response.json({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] })) as unknown as typeof fetch });
    expect((await p.test()).ok).toBe(true);
  });
});

describe("switching providers keeps sessions and history intact", () => {
  it("activeModel picks the configured model per provider and ignores incompatible session overrides", () => {
    const p = DEFAULT_SETTINGS.provider;
    expect(activeModel({ ...p, kind: "anthropic" })).toBe("claude-opus-5-5");
    expect(activeModel({ ...p, kind: "openai" })).toBe("gpt-5");
    expect(activeModel({ ...p, kind: "gemini" })).toBe("gemini-2.5-flash");
    expect(activeModel({ ...p, kind: "gemini" }, "claude-sonnet-5-5")).toBe("gemini-2.5-flash");
    expect(activeModel({ ...p, kind: "anthropic" }, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("a conversation started on one provider continues after switching", async () => {
    const h = harness({ turns: [{ text: ["first"] }, { text: ["second"] }] });
    const first = await h.ask("Q1");
    const conv = (first.find((e) => e.type === "start") as { conversationId: string }).conversationId;
    h.core.updateSettings({ provider: { kind: "gemini" } });
    expect(h.core.health.state).toBe("unconfigured"); // no Gemini key in the harness
    h.core.updateSettings({ provider: { kind: "anthropic" } });
    await h.ask("Q2", { conversationId: conv });
    expect(h.store.listMessages(conv).map((m) => m.content)).toEqual(["Q1", "first", "Q2", "second"]);
  });
});
