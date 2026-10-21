import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { ProviderTestResult } from "../../shared/types";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./retry";
import {
  CancelledError,
  idleWatchdog,
  ProviderError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type ProviderMessage,
  type StreamHooks,
} from "./types";

// Server-side refusal fallback ("default" routing by refusal category). Claude Haiku 5.5 has no
// server-side fallback, so it is excluded.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
  retry?: RetryOptions;
  /** Injected for tests. */
  client?: Anthropic;
}

export class AnthropicProvider implements AIProvider {
  readonly kind = "anthropic" as const;
  readonly isMock = false;
  readonly supportsImages = true;
  private readonly client: Anthropic;
  private readonly retry: RetryOptions;

  constructor(opts: AnthropicProviderOptions) {
    // SDK retries are disabled: we retry ourselves so we never retry after tokens were streamed.
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const params = this.toParams(req);
    const { value, retries } = await withRetry(
      async (markStarted) => {
        const started = Date.now();
        let ttftMs: number | null = null;
        const watchdog = idleWatchdog(signal, req.idleTimeoutMs);
        try {
          const stream = this.client.beta.messages.stream(params, { signal: watchdog.signal, timeout: req.timeoutMs });
          for await (const event of stream) {
            watchdog.kick();
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (ttftMs === null) ttftMs = Date.now() - started;
              markStarted();
              hooks?.onDelta?.(event.delta.text);
            }
          }
          const final = await stream.finalMessage();
          return this.toResult(final, ttftMs);
        } catch (err) {
          if (watchdog.stalled() && !signal.aborted) throw new ProviderError("The AI provider stopped responding.", "timeout", true);
          throw mapError(err, signal);
        } finally {
          watchdog.dispose();
        }
      },
      signal,
      this.retry,
      hooks?.onRetry,
    );
    return { ...value, retries };
  }

  async test(model: string): Promise<ProviderTestResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    try {
      const res = await this.generate(
        {
          model,
          system: [{ text: "Reply with the single word: ready", cache: false }],
          messages: [{ role: "user", content: "Connection test." }],
          maxTokens: 512,
          effort: "low",
          timeoutMs: 30_000,
        },
        ctrl.signal,
      );
      return { ok: true, message: `Connected to ${res.model}.`, latencyMs: Date.now() - started };
    } catch (err) {
      const e = err instanceof ProviderError ? err : mapError(err, ctrl.signal);
      return { ok: false, message: e.message, latencyMs: null };
    }
  }

  private toParams(req: GenerateRequest): Anthropic.Beta.Messages.MessageCreateParamsStreaming {
    const system: BetaTextBlockParam[] = req.system.map((s) => ({
      type: "text",
      text: s.text,
      ...(s.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const useFallback = FALLBACK_MODELS.has(req.model);
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages: req.messages.map(toBetaMessage),
      stream: true,
      // Thinking is left at the model default (adaptive); effort controls depth and latency.
      output_config: {
        effort: req.effort,
        ...(req.jsonSchema ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
      },
      ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  private toResult(msg: BetaMessage, ttftMs: number | null): Omit<GenerateResult, "retries"> {
    if (msg.stop_reason === "refusal") {
      throw new ProviderError("The model declined to answer this request.", "refusal", false);
    }
    let servedByFallback: string | null = null;
    const text = msg.content
      .map((b) => {
        if (b.type === "fallback") servedByFallback = b.to.model;
        return b.type === "text" ? b.text : "";
      })
      .join("");
    if (!servedByFallback && (msg.usage.iterations ?? []).some((i) => i.type === "fallback_message")) {
      servedByFallback = "fallback model";
    }
    return {
      text,
      model: msg.model,
      stopReason: msg.stop_reason ?? "unknown",
      servedByFallback,
      ttftMs,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function toBetaMessage(m: ProviderMessage): BetaMessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  const content: BetaContentBlockParam[] = m.content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } },
  );
  return { role: m.role, content };
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const v = headers?.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

/** Translate SDK errors into safe, user-facing ProviderErrors (never leak keys or raw bodies). */
export function mapError(err: unknown, signal: AbortSignal): Error {
  if (err instanceof ProviderError || err instanceof CancelledError) return err;
  if (signal.aborted || err instanceof APIUserAbortError) return new CancelledError();
  if (err instanceof APIConnectionTimeoutError)
    return new ProviderError("The AI provider timed out.", "timeout", true);
  if (err instanceof APIConnectionError)
    return new ProviderError("Cannot reach the AI provider. Check your network connection.", "network", true);
  if (err instanceof AuthenticationError)
    return new ProviderError("The Anthropic API key was rejected. Update it in Settings → AI provider.", "auth", false);
  if (err instanceof PermissionDeniedError)
    return new ProviderError("This API key does not have access to the selected model.", "auth", false);
  if (err instanceof RateLimitError)
    return new ProviderError("Rate limited by the AI provider.", "rate_limited", true, retryAfter(err.headers));
  if (err instanceof NotFoundError)
    return new ProviderError("The selected model was not found. Choose another model in Settings.", "bad_request", false);
  if (err instanceof BadRequestError) {
    const tooLarge = /too long|context|prompt is too long/i.test(err.message);
    return new ProviderError(
      tooLarge ? "The request is too large. Remove some context and try again." : "The AI provider rejected the request.",
      tooLarge ? "context_too_large" : "bad_request",
      false,
    );
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    if (status === 529 || status === 503)
      return new ProviderError("The AI provider is overloaded.", "overloaded", true, retryAfter(err.headers));
    if (status >= 500) return new ProviderError("The AI provider had a temporary error.", "overloaded", true);
    return new ProviderError(`The AI provider returned an error (${status}).`, "unknown", false);
  }
  // Raw socket/stream failures (connection reset mid-stream, DNS, TLS) are not wrapped by the SDK.
  const msg = err instanceof Error ? `${err.name} ${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  if (err instanceof TypeError || /network|terminated|socket|ECONN|ETIMEDOUT|EPIPE|fetch failed|connection/i.test(msg)) {
    return new ProviderError("The connection to the AI provider was interrupted.", "network", true);
  }
  return new ProviderError("Unexpected error while contacting the AI provider.", "unknown", false);
}
