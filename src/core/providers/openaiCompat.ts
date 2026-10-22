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

/**
 * Provider for any server speaking the OpenAI-compatible `/chat/completions` streaming protocol
 * (e.g. a local Ollama, LM Studio, vLLM or llama.cpp server). Implemented over plain fetch + SSE so
 * no extra SDK is bundled. The API key is optional (local servers usually need none) and is only
 * ever sent to the configured base URL.
 */
export class OpenAICompatProvider implements AIProvider {
  readonly kind: "openai_compat" | "openai";
  readonly isMock = false;
  readonly supportsImages: boolean;
  private readonly retry: RetryOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      baseUrl: string;
      model: string;
      apiKey?: string | null;
      supportsImages?: boolean;
      retry?: RetryOptions;
      fetch?: typeof fetch;
      /** "openai" targets api.openai.com (uses `max_completion_tokens`, required by reasoning models). */
      flavor?: "openai" | "openai_compat";
    },
  ) {
    this.kind = opts.flavor ?? "openai_compat";
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.fetchImpl = opts.fetch ?? fetch;
    this.supportsImages = opts.supportsImages ?? false;
  }

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private toMessages(req: GenerateRequest) {
    const system = req.system.map((s) => s.text).join("\n\n");
    const conv = req.messages.map((m: ProviderMessage) => {
      if (typeof m.content === "string") return { role: m.role, content: m.content };
      const parts = m.content
        .filter((p) => p.type === "text" || this.supportsImages)
        .map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }));
      return { role: m.role, content: this.supportsImages ? parts : parts.map((p) => ("text" in p ? p.text : "")).join("\n") };
    });
    return [{ role: "system", content: system }, ...conv];
  }

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const body = JSON.stringify({
      model: this.opts.model,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.kind === "openai" ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      messages: this.toMessages(req),
      ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "output", schema: req.jsonSchema, strict: true } } } : {}),
    });
    const { value, retries } = await withRetry(
      async (markStarted) => {
        const started = Date.now();
        let ttftMs: number | null = null;
        const wd = idleWatchdog(signal, req.idleTimeoutMs ?? req.timeoutMs);
        try {
          let res: Response;
          try {
            res = await this.fetchImpl(this.url("/chat/completions"), {
              method: "POST",
              signal: wd.signal,
              headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
              body,
            });
          } catch {
            if (signal.aborted) throw new CancelledError();
            if (wd.stalled()) throw new ProviderError("The AI provider timed out.", "timeout", true);
            throw new ProviderError(`Cannot reach ${new URL(this.opts.baseUrl).host}. Is the server running?`, "network", true);
          }
          if (!res.ok) throw await httpError(res);
          if (!res.body) throw new ProviderError("The AI provider returned an empty response.", "unknown", true);
          let text = "";
          let finish = "stop";
          let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          const reader = res.body.getReader();
          // Cancel the body read as soon as the user (or the stall watchdog) aborts, even if the
          // underlying fetch implementation keeps the stream open.
          const onAbort = () => void reader.cancel().catch(() => undefined);
          wd.signal.addEventListener("abort", onAbort, { once: true });
          const dec = new TextDecoder();
          let buf = "";
          try {
            for (;;) {
              if (wd.signal.aborted) throw new CancelledError();
              const { done, value: chunk } = await reader.read();
              if (wd.signal.aborted) throw new CancelledError();
              if (done) break;
              wd.kick();
              buf += dec.decode(chunk, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") continue;
                let evt: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
                try {
                  evt = JSON.parse(data);
                } catch {
                  continue;
                }
                const delta = evt.choices?.[0]?.delta?.content;
                if (delta) {
                  if (ttftMs === null) ttftMs = Date.now() - started;
                  markStarted();
                  text += delta;
                  hooks?.onDelta?.(delta);
                }
                const fr = evt.choices?.[0]?.finish_reason;
                if (fr) finish = fr;
                if (evt.usage) usage = { ...usage, inputTokens: evt.usage.prompt_tokens ?? 0, outputTokens: evt.usage.completion_tokens ?? 0 };
              }
            }
          } catch {
            if (signal.aborted) throw new CancelledError();
            if (wd.stalled()) throw new ProviderError("The AI provider stopped responding.", "timeout", true);
            throw new ProviderError("The connection to the AI provider was interrupted.", "network", true);
          } finally {
            wd.signal.removeEventListener("abort", onAbort);
          }
          return {
            text,
            usage,
            stopReason: finish === "length" ? "max_tokens" : finish === "stop" ? "end_turn" : finish,
            model: this.opts.model,
            servedByFallback: null,
            ttftMs,
          };
        } finally {
          wd.dispose();
        }
      },
      signal,
      this.retry,
      hooks?.onRetry,
    );
    return { ...value, retries };
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.url("/models"), {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const e = await httpError(res);
        return { ok: false, message: e.message, latencyMs: null };
      }
      const json = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
      const ids = (json.data ?? []).map((m) => m.id);
      const hasModel = ids.length === 0 || ids.includes(this.opts.model);
      return {
        ok: hasModel,
        message: hasModel ? `Connected to ${new URL(this.opts.baseUrl).host}.` : `Connected, but model “${this.opts.model}” is not available. Available: ${ids.slice(0, 8).join(", ")}`,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { ok: false, message: `Cannot reach ${safeHost(this.opts.baseUrl)}.`, latencyMs: null };
    }
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "the configured server";
  }
}

async function httpError(res: Response): Promise<ProviderError> {
  const retryAfter = Number(res.headers.get("retry-after"));
  const ra = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  await res.body?.cancel().catch(() => undefined);
  switch (true) {
    case res.status === 401 || res.status === 403:
      return new ProviderError("The AI provider rejected the credentials.", "auth", false);
    case res.status === 404:
      return new ProviderError("The model or endpoint was not found. Check the base URL and model name.", "bad_request", false);
    case res.status === 429:
      return new ProviderError("Rate limited by the AI provider.", "rate_limited", true, ra);
    case res.status === 400 || res.status === 413 || res.status === 422:
      return new ProviderError("The AI provider rejected the request.", "bad_request", false);
    case res.status >= 500:
      return new ProviderError("The AI provider had a temporary error.", "overloaded", true, ra);
    default:
      return new ProviderError(`The AI provider returned an error (${res.status}).`, "unknown", false);
  }
}
