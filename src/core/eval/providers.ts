// Providers used by the evaluation runner. Both record the exact request Lumen built, so every
// result can show its real input. The scripted provider is used only in deterministic mode and is
// always labelled as such; it is never substituted for a live model.

import { abortableSleep, withRetry, type RetryOptions } from "../providers/retry";
import { CancelledError, ProviderError, type AIProvider, type GenerateRequest, type GenerateResult, type StreamHooks } from "../providers/types";
import type { ProviderTestResult } from "../../shared/types";
import type { Script } from "./types";

export const SCRIPTED_ANSWER = "[Scripted evaluation response. This is not model output.]";
export const SCRIPTED_MODEL = "scripted";

const NO_SLEEP: RetryOptions = { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined };

export class ScriptedProvider implements AIProvider {
  readonly kind = "mock" as const;
  readonly isMock = true;
  readonly supportsImages = true;
  readonly requests: GenerateRequest[] = [];
  private attempt = 0;

  constructor(private readonly script: Script = {}) {}

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    this.requests.push(req);
    // The real retry policy runs, so retry/backoff behaviour is exercised, not simulated.
    const { value, retries } = await withRetry(
      async (markStarted) => {
        const i = this.attempt++;
        const err = this.script.errors?.[i];
        if (err) throw new ProviderError(err.message ?? `Scripted ${err.code}`, err.code, err.retryable);
        if (this.script.cancelAfterMs !== undefined) {
          markStarted();
          hooks?.onDelta?.("Partial ");
          await abortableSleep(10_000, signal);
        }
        const text = this.script.empty ? "" : (this.script.answer ?? SCRIPTED_ANSWER);
        if (text) {
          markStarted();
          hooks?.onDelta?.(text);
        }
        return text;
      },
      signal,
      NO_SLEEP,
      hooks?.onRetry,
    );
    return {
      text: value,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: this.script.stopReason ?? "end_turn",
      model: SCRIPTED_MODEL,
      servedByFallback: null,
      ttftMs: 0,
      retries,
    };
  }

  async test(): Promise<ProviderTestResult> {
    return { ok: true, message: "Scripted evaluation provider.", latencyMs: 0 };
  }
}

/** Wraps a real provider: forwards everything, records the request, caps output tokens. */
export class RecordingProvider implements AIProvider {
  readonly requests: GenerateRequest[] = [];
  constructor(
    private readonly inner: AIProvider,
    private readonly maxOutputTokens: number,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  get isMock() {
    return this.inner.isMock;
  }
  get supportsImages() {
    return this.inner.supportsImages;
  }
  generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const capped = { ...req, maxTokens: Math.min(req.maxTokens, this.maxOutputTokens) };
    this.requests.push(capped);
    if (signal.aborted) return Promise.reject(new CancelledError());
    return this.inner.generate(capped, signal, hooks);
  }
  test(model: string) {
    return this.inner.test(model);
  }
}
