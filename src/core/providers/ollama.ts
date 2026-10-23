// Local inference through an Ollama runtime (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Uses the native API rather than the OpenAI-compatible one because only the native API exposes
// installed models, per-model capabilities and context length, loaded-model memory, embeddings,
// and lets us set the context window (`num_ctx`) — without which Ollama silently drops the start of
// an oversized prompt, i.e. the system policy.
//
// Lumen never starts, installs or downloads anything: the user runs Ollama and pulls models.
// The endpoint must be loopback so "local" really means on this device.

import type { ProviderTestResult } from "../../shared/types";
import { DEFAULT_RETRY, retryFor, withRetry, type RetryOptions } from "./retry";
import { CancelledError, idleWatchdog, ProviderError, type AIProvider, type GenerateRequest, type GenerateResult, type ProviderCapabilities, type StreamHooks } from "./types";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** True only for http(s) URLs on this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export interface LocalModelInfo {
  name: string;
  sizeBytes: number;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

export interface LocalModelDetails extends LocalModelInfo {
  capabilities: string[];
  contextLength: number | null;
}

export interface RuntimeStatus {
  available: boolean;
  version: string | null;
  checkedAt: number;
  error: string | null;
  models: LocalModelInfo[];
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
}

type Fetch = typeof fetch;

/** Discovery and metadata calls. Short timeouts: a missing runtime must not slow Lumen down. */
export class OllamaRuntime {
  private readonly fetchImpl: Fetch;
  private details = new Map<string, LocalModelDetails>();

  constructor(
    readonly baseUrl: string = DEFAULT_OLLAMA_URL,
    opts: { fetch?: Fetch; connectTimeoutMs?: number } = {},
  ) {
    if (!isLoopbackUrl(baseUrl)) throw new ProviderError("The local runtime address must be on this computer (127.0.0.1, localhost or [::1]).", "bad_request", false);
    this.fetchImpl = opts.fetch ?? fetch;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 1500;
  }

  readonly connectTimeoutMs: number;

  private url(p: string) {
    return `${this.baseUrl.replace(/\/+$/, "")}${p}`;
  }

  private async json<T>(p: string, init?: RequestInit, timeoutMs = this.connectTimeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(p), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      throw new ProviderError(
        timedOut ? `Ollama did not answer within ${timeoutMs} ms at ${this.baseUrl}.` : `Ollama is not running at ${this.baseUrl}. Start it (the Ollama app, or \`ollama serve\`) and try again.`,
        timedOut ? "timeout" : "network",
        false,
      );
    }
    if (!res.ok) throw await ollamaError(res);
    return (await res.json()) as T;
  }

  async status(now = Date.now()): Promise<RuntimeStatus> {
    try {
      const v = await this.json<{ version?: string }>("/api/version");
      const models = await this.listModels();
      return { available: true, version: v.version ?? null, checkedAt: now, error: null, models };
    } catch (e) {
      return { available: false, version: null, checkedAt: now, error: (e as Error).message, models: [] };
    }
  }

  async listModels(): Promise<LocalModelInfo[]> {
    const r = await this.json<{ models?: { name: string; size?: number; details?: { family?: string; parameter_size?: string; quantization_level?: string } }[] }>("/api/tags");
    return (r.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      family: m.details?.family ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
    }));
  }

  /** Capabilities and context length of one installed model (cached per model name). */
  async show(model: string): Promise<LocalModelDetails> {
    const hit = this.details.get(model);
    if (hit) return hit;
    const r = await this.json<{ capabilities?: string[]; model_info?: Record<string, unknown>; details?: { family?: string; parameter_size?: string; quantization_level?: string } }>(
      "/api/show",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) },
      5000,
    );
    const ctxKey = Object.keys(r.model_info ?? {}).find((k) => k.endsWith(".context_length"));
    const ctx = ctxKey ? Number(r.model_info![ctxKey]) : NaN;
    const d: LocalModelDetails = {
      name: model,
      sizeBytes: 0,
      family: r.details?.family ?? null,
      parameterSize: r.details?.parameter_size ?? null,
      quantization: r.details?.quantization_level ?? null,
      // Older Ollama versions omit capabilities; then only text completion is assumed.
      capabilities: r.capabilities ?? ["completion"],
      contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    };
    this.details.set(model, d);
    return d;
  }

  /** Models currently loaded in memory and their footprint (for evaluation reports). */
  async loaded(): Promise<LoadedModel[]> {
    const r = await this.json<{ models?: { name: string; size?: number; size_vram?: number }[] }>("/api/ps");
    return (r.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? 0, vramBytes: m.size_vram ?? 0 }));
  }

  /** Embed texts with a local embedding model. */
  async embed(model: string, input: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<{ vectors: number[][]; model: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url("/api/embed"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input, truncate: true }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      throw new ProviderError(
        (e as Error)?.name === "TimeoutError" ? "Local embedding timed out." : `Ollama is not running at ${this.baseUrl}.`,
        (e as Error)?.name === "TimeoutError" ? "timeout" : "network",
        false,
      );
    }
    if (!res.ok) throw await ollamaError(res);
    const j = (await res.json()) as { embeddings?: number[][]; model?: string };
    const vectors = j.embeddings ?? [];
    if (vectors.length !== input.length || vectors.some((v) => !Array.isArray(v) || !v.length)) throw new ProviderError("The local embedding model returned malformed vectors.", "unknown", false);
    return { vectors, model: j.model ?? model };
  }
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model: string;
  /** Context window to request (tokens). Larger needs more memory. */
  numCtx: number;
  /** Supported features of this model, from `OllamaRuntime.show`; text-only when unknown. */
  details?: LocalModelDetails | null;
  retry?: RetryOptions;
  fetch?: Fetch;
}

/** Chat generation against a local Ollama model (`/api/chat`, NDJSON streaming). */
export class OllamaProvider implements AIProvider {
  readonly kind = "ollama" as const;
  readonly isMock = false;
  readonly supportsImages: boolean;
  readonly capabilities: ProviderCapabilities;
  private readonly fetchImpl: Fetch;
  private readonly retry: RetryOptions;
  private readonly baseUrl: string;

  constructor(private readonly opts: OllamaProviderOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_OLLAMA_URL;
    if (!isLoopbackUrl(this.baseUrl)) throw new ProviderError("The local runtime address must be on this computer.", "bad_request", false);
    this.fetchImpl = opts.fetch ?? fetch;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    const caps = opts.details?.capabilities ?? ["completion"];
    this.supportsImages = caps.includes("vision");
    const ctx = Math.min(opts.numCtx, opts.details?.contextLength ?? opts.numCtx);
    this.capabilities = {
      location: "local",
      streaming: true,
      cancellation: true,
      vision: this.supportsImages,
      // Ollama accepts a JSON schema in `format`; small models do not always follow it.
      structuredOutput: "best_effort",
      usage: "reported",
      contextTokens: ctx,
    };
  }

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const ctx = this.capabilities.contextTokens!;
    const system = req.system.map((s) => s.text).join("\n\n");
    const messages = [
      { role: "system", content: system },
      ...req.messages.map((m) => {
        if (typeof m.content === "string") return { role: m.role, content: m.content };
        const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
        const images = this.supportsImages ? m.content.flatMap((p) => (p.type === "image" ? [p.data] : [])) : [];
        return { role: m.role, content: text, ...(images.length ? { images } : {}) };
      }),
    ];
    // Refuse rather than let Ollama truncate the prompt from the front (which removes the policy).
    const estimate = estimateTokens(JSON.stringify(messages));
    const out = Math.min(req.maxTokens, Math.max(256, Math.floor(ctx / 4)));
    if (estimate + out > ctx) {
      throw new ProviderError(
        `This request (~${estimate.toLocaleString()} tokens) does not fit the local model's ${ctx.toLocaleString()}-token context. Remove some context, raise the local context size, or use a cloud model.`,
        "context_too_large",
        false,
      );
    }
    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      stream: true,
      options: { num_ctx: ctx, num_predict: out },
      ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
    });
    const { value, retries } = await withRetry(
      async (markStarted) => {
        const started = Date.now();
        let ttftMs: number | null = null;
        // Local models may need time to load into memory before the first token; the idle watchdog
        // covers that, and an overall deadline bounds very slow generation.
        let timedOut = false;
        const deadline = new AbortController();
        const overall = setTimeout(() => {
          timedOut = true;
          deadline.abort();
        }, req.timeoutMs);
        const wd = idleWatchdog(AbortSignal.any([signal, deadline.signal]), req.idleTimeoutMs ?? req.timeoutMs);
        const slow = () => timedOut || wd.stalled();
        try {
          let res: Response;
          try {
            res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: wd.signal });
          } catch {
            if (signal.aborted) throw new CancelledError();
            if (slow()) throw new ProviderError("The local model did not start answering in time. It may still be loading, or this computer may be too slow for it.", "timeout", false);
            throw new ProviderError(`Ollama is not running at ${this.baseUrl}. Start it and try again.`, "network", true);
          }
          if (!res.ok) throw await ollamaError(res, this.opts.model);
          if (!res.body) throw new ProviderError("The local model returned an empty response.", "unknown", false);
          const reader = res.body.getReader();
          const onAbort = () => void reader.cancel().catch(() => undefined);
          wd.signal.addEventListener("abort", onAbort, { once: true });
          const dec = new TextDecoder();
          let buf = "";
          let text = "";
          let doneReason = "stop";
          let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          try {
            for (;;) {
              const { done, value: chunk } = await reader.read();
              if (wd.signal.aborted) throw new CancelledError();
              if (done) break;
              wd.kick();
              buf += dec.decode(chunk, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let evt: { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
                try {
                  evt = JSON.parse(line);
                } catch {
                  continue;
                }
                if (evt.error) throw new ProviderError(`Local model error: ${evt.error.slice(0, 200)}`, "unknown", false);
                const delta = evt.message?.content;
                if (delta) {
                  if (ttftMs === null) ttftMs = Date.now() - started;
                  markStarted();
                  text += delta;
                  hooks?.onDelta?.(delta);
                }
                if (evt.done) {
                  doneReason = evt.done_reason ?? "stop";
                  usage = { ...usage, inputTokens: evt.prompt_eval_count ?? 0, outputTokens: evt.eval_count ?? 0 };
                }
              }
            }
          } catch (e) {
            if (e instanceof ProviderError) throw e;
            if (signal.aborted) throw new CancelledError();
            if (slow()) throw new ProviderError(timedOut ? `The local model did not finish within ${Math.round(req.timeoutMs / 1000)} s.` : "The local model stopped responding.", "timeout", false);
            throw new ProviderError("The connection to the local runtime was interrupted.", "network", false);
          } finally {
            wd.signal.removeEventListener("abort", onAbort);
          }
          return { text, usage, stopReason: doneReason === "length" ? "max_tokens" : "end_turn", model: this.opts.model, servedByFallback: null, ttftMs };
        } finally {
          clearTimeout(overall);
          wd.dispose();
        }
      },
      signal,
      retryFor(this.retry, req),
      hooks?.onRetry,
    );
    return { ...value, retries };
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    const rt = new OllamaRuntime(this.baseUrl, { fetch: this.fetchImpl, connectTimeoutMs: 3000 });
    try {
      const models = await rt.listModels();
      const has = models.some((m) => m.name === this.opts.model || m.name === `${this.opts.model}:latest`);
      if (!has)
        return {
          ok: false,
          message: models.length
            ? `Ollama is running, but “${this.opts.model}” is not installed. Installed: ${models
                .map((m) => m.name)
                .slice(0, 8)
                .join(", ")}.`
            : `Ollama is running but has no models. Install one with: ollama pull ${this.opts.model || "llama3.2"}`,
          latencyMs: null,
          code: "model_unavailable",
        };
      return { ok: true, message: `Connected to Ollama (${this.opts.model}, local).`, latencyMs: Date.now() - started };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("Cannot reach Ollama.", "network", false);
      return { ok: false, message: pe.message, latencyMs: null, code: pe.code };
    }
  }
}

/** Rough token count for budgeting (≈3.5 characters per token for English and code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

async function ollamaError(res: Response, model?: string): Promise<ProviderError> {
  let msg = "";
  try {
    msg = String(((await res.json()) as { error?: unknown }).error ?? "");
  } catch {
    /* no body */
  }
  if (res.status === 404 || /not found|pull/i.test(msg))
    return new ProviderError(`The local model${model ? ` “${model}”` : ""} is not installed. Install it yourself with: ollama pull ${model ?? "<model>"}`, "bad_request", false);
  if (/memory|out of memory|insufficient|resource/i.test(msg))
    return new ProviderError("This computer does not have enough memory for the local model. Choose a smaller model or close other apps.", "overloaded", false);
  if (res.status >= 500) return new ProviderError(`The local runtime had an error${msg ? `: ${msg.slice(0, 160)}` : ""}.`, "overloaded", false);
  return new ProviderError(`The local runtime rejected the request${msg ? `: ${msg.slice(0, 160)}` : ""}.`, "bad_request", false);
}
