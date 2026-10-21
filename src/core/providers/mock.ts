import type { ProviderTestResult } from "../../shared/types";
import { abortableSleep } from "./retry";
import { CancelledError, type AIProvider, type GenerateRequest, type GenerateResult, type StreamHooks } from "./types";

export const MOCK_BANNER = "**[Development mode — mock provider. This is not an AI-generated answer.]**";

/**
 * Explicit development-mode provider. It never pretends to be a model: every response starts with
 * a visible banner and only echoes what context it received, so the UI and pipeline can be
 * exercised without credentials.
 */
export class MockProvider implements AIProvider {
  readonly kind = "mock" as const;
  readonly isMock = true;
  readonly supportsImages = true;

  constructor(private readonly delayMs = 15) {}

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const started = Date.now();
    const last = req.messages.at(-1);
    const parts = typeof last?.content === "string" ? [{ type: "text" as const, text: last.content }] : (last?.content ?? []);
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const images = parts.filter((p) => p.type === "image").length;
    const labels = [...text.matchAll(/label="(C\d+)" kind="([^"]+)" title="([^"]*)"/g)].map((m) => `[${m[1]}] ${m[2]}: ${m[3]}`);
    const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(text)?.[1] ?? text.slice(0, 200);

    let body: string;
    if (req.jsonSchema) {
      body = JSON.stringify(mockStructured(req.jsonSchema));
    } else {
      body = [
        MOCK_BANNER,
        "",
        `You asked: "${question.trim().slice(0, 300)}"`,
        "",
        labels.length ? `Context sources received (${labels.length}):\n${labels.map((l) => `- ${l}`).join("\n")}` : "No context sources were attached.",
        images ? `\nImages attached: ${images}` : "",
        "",
        "Add an Anthropic API key in Settings → AI provider to get real answers.",
      ].join("\n");
    }

    let ttftMs: number | null = null;
    for (const chunk of body.match(/.{1,24}/gs) ?? []) {
      if (signal.aborted) throw new CancelledError();
      await abortableSleep(this.delayMs, signal);
      if (ttftMs === null) ttftMs = Date.now() - started;
      hooks?.onDelta?.(chunk);
    }
    return {
      text: body,
      model: "mock",
      stopReason: "end_turn",
      servedByFallback: null,
      ttftMs,
      retries: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  async test(): Promise<ProviderTestResult> {
    return { ok: true, message: "Mock provider is active (development mode, no real AI).", latencyMs: 0 };
  }
}

function mockStructured(schema: Record<string, unknown>): unknown {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; properties?: unknown }>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.type === "array") out[k] = [];
    else if (v.type === "object") out[k] = mockStructured(v as Record<string, unknown>);
    else out[k] = `[mock] ${k}`;
  }
  return out;
}
