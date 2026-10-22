// Real-network checks. Run with: ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… DEEPGRAM_API_KEY=… npm run test:live
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../core/providers/anthropic";
import { GeminiProvider } from "../core/providers/gemini";
import { OpenAICompatProvider } from "../core/providers/openaiCompat";
import type { GenerateRequest } from "../core/providers/types";
import { DeepgramProvider } from "../core/transcription/deepgram";

const req = (model: string): GenerateRequest => ({ model, system: [{ text: "Reply with exactly: ok", cache: false }], messages: [{ role: "user", content: "ping" }], maxTokens: 512, effort: "low", timeoutMs: 60_000 });
const env = process.env;

describe.runIf(!!env.ANTHROPIC_API_KEY)("Anthropic (live)", () => {
  it("streams a reply and reports usage", async () => {
    const p = new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY! });
    const deltas: string[] = [];
    const r = await p.generate(req(env.LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5"), new AbortController().signal, { onDelta: (d) => deltas.push(d) });
    expect(r.text.toLowerCase()).toContain("ok");
    expect(deltas.length).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    console.log("anthropic ttftMs", r.ttftMs);
  });
});

describe.runIf(!!env.OPENAI_API_KEY)("OpenAI (live)", () => {
  it("streams a reply", async () => {
    const p = new OpenAICompatProvider({ flavor: "openai", baseUrl: "https://api.openai.com/v1", model: env.LIVE_OPENAI_MODEL ?? "gpt-4o-mini", apiKey: env.OPENAI_API_KEY!, supportsImages: true });
    const r = await p.generate(req("x"), new AbortController().signal);
    expect(r.text.toLowerCase()).toContain("ok");
    console.log("openai ttftMs", r.ttftMs);
  });
});

describe.runIf(!!env.GEMINI_API_KEY)("Gemini (live)", () => {
  it("streams a reply", async () => {
    const p = new GeminiProvider({ apiKey: env.GEMINI_API_KEY!, model: env.LIVE_GEMINI_MODEL ?? "gemini-2.5-flash" });
    const r = await p.generate(req("x"), new AbortController().signal);
    expect(r.text.toLowerCase()).toContain("ok");
    console.log("gemini ttftMs", r.ttftMs);
  });
});

describe.runIf(!!env.DEEPGRAM_API_KEY)("Deepgram (live)", () => {
  it("opens an authenticated stream and closes cleanly", async () => {
    const p = new DeepgramProvider(env.DEEPGRAM_API_KEY!);
    await new Promise<void>((resolve, reject) => {
      const s = p.open({ language: "en", diarize: false, channels: 1 }, {
        onOpen: () => {
          s.sendAudio(new Uint8Array(32000));
          setTimeout(() => s.close(), 500);
        },
        onResult: () => undefined,
        onError: (m) => reject(new Error(m)),
        onClose: (unexpected, reason, fatal) => (fatal ? reject(new Error(reason)) : resolve()),
      });
    });
  });
});
