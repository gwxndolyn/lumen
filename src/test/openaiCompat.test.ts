import { describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../core/providers/openaiCompat";
import { CancelledError, ProviderError, type GenerateRequest } from "../core/providers/types";
import { noSleep } from "./helpers";

const req: GenerateRequest = {
  model: "ignored",
  system: [{ text: "policy", cache: true }],
  messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "AAA" }, { type: "text", text: "hello" }] }],
  maxTokens: 100,
  effort: "low",
  timeoutMs: 5000,
};

function sseResponse(chunks: string[], delayMs = 0) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const ch of chunks) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`));
        }
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAI-compatible provider", () => {
  it("streams, reports usage, sends system+text and omits images when unsupported", async () => {
    const bodies: any[] = [];
    const p = new OpenAICompatProvider({
      baseUrl: "http://localhost:11434/v1/",
      model: "llama3.1",
      retry: noSleep,
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://localhost:11434/v1/chat/completions");
        bodies.push(JSON.parse(String(init.body)));
        return sseResponse(["Hel", "lo"]);
      }) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const r = await p.generate(req, new AbortController().signal, { onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r).toMatchObject({ text: "Hello", stopReason: "end_turn", model: "llama3.1", usage: { inputTokens: 7, outputTokens: 3 } });
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "policy" });
    expect(bodies[0].messages[1].content).toBe("hello");
    expect(JSON.stringify(bodies[0])).not.toContain("AAA");
  });

  it("retries 503 then succeeds; maps 401 to auth without retry; network to a clear message", async () => {
    let n = 0;
    const flaky = new OpenAICompatProvider({ baseUrl: "http://x/v1", model: "m", retry: noSleep, fetch: (async () => (n++ === 0 ? new Response("busy", { status: 503 }) : sseResponse(["ok"]))) as unknown as typeof fetch });
    const r = await flaky.generate(req, new AbortController().signal);
    expect(r.text).toBe("ok");
    expect(r.retries).toBe(1);
    const auth = new OpenAICompatProvider({ baseUrl: "http://x/v1", model: "m", apiKey: "secret-key", retry: noSleep, fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch });
    const e = (await auth.generate(req, new AbortController().signal).catch((x) => x)) as ProviderError;
    expect(e.code).toBe("auth");
    expect(e.message).not.toContain("secret-key");
    const down = new OpenAICompatProvider({ baseUrl: "http://localhost:9/v1", model: "m", retry: noSleep, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const d = (await down.generate(req, new AbortController().signal).catch((x) => x)) as ProviderError;
    expect(d).toMatchObject({ code: "network" });
    expect(d.message).toMatch(/localhost:9/);
  });

  it("cancels mid-stream", async () => {
    const p = new OpenAICompatProvider({
      baseUrl: "http://x/v1",
      model: "m",
      retry: noSleep,
      fetch: (async (_u: string, init: RequestInit) => {
        const res = sseResponse(Array.from({ length: 50 }, () => "x"), 5);
        init.signal?.addEventListener("abort", () => void res.body?.cancel().catch(() => undefined));
        return res;
      }) as unknown as typeof fetch,
    });
    const ctrl = new AbortController();
    let n = 0;
    await expect(p.generate(req, ctrl.signal, { onDelta: () => ++n === 3 && ctrl.abort() })).rejects.toBeInstanceOf(CancelledError);
  });

  it("health check lists models and flags a missing model", async () => {
    const p = new OpenAICompatProvider({ baseUrl: "http://x/v1", model: "absent", fetch: (async () => Response.json({ data: [{ id: "llama3.1" }] })) as unknown as typeof fetch });
    const t = await p.test();
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/not available/);
  });
});
