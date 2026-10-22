import type { ProviderTestResult } from "../../shared/types";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./retry";
import { CancelledError, idleWatchdog, ProviderError, type AIProvider, type GenerateRequest, type GenerateResult, type StreamHooks } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Google Gemini via the Generative Language REST API (`streamGenerateContent?alt=sse`). The key is
 * sent in the `x-goog-api-key` header — never in the URL, so it cannot leak through logs or proxies.
 */
export class GeminiProvider implements AIProvider {
  readonly kind = "gemini" as const;
  readonly isMock = false;
  readonly supportsImages = true;
  private readonly retry: RetryOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: { apiKey: string; model: string; retry?: RetryOptions; fetch?: typeof fetch; baseUrl?: string }) {
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private get base() {
    return (this.opts.baseUrl ?? BASE).replace(/\/+$/, "");
  }

  private body(req: GenerateRequest) {
    const contents = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((p) => (p.type === "text" ? { text: p.text } : { inline_data: { mime_type: p.mediaType, data: p.data } })),
    }));
    return JSON.stringify({
      systemInstruction: { parts: [{ text: req.system.map((s) => s.text).join("\n\n") }] },
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {}),
      },
    });
  }

  async generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult> {
    const body = this.body(req);
    const url = `${this.base}/models/${encodeURIComponent(this.opts.model)}:streamGenerateContent?alt=sse`;
    const { value, retries } = await withRetry(
      async (markStarted) => {
        const started = Date.now();
        let ttftMs: number | null = null;
        const wd = idleWatchdog(signal, req.idleTimeoutMs ?? req.timeoutMs);
        try {
          let res: Response;
          try {
            res = await this.fetchImpl(url, { method: "POST", signal: wd.signal, headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey }, body });
          } catch {
            if (signal.aborted) throw new CancelledError();
            if (wd.stalled()) throw new ProviderError("Gemini timed out.", "timeout", true);
            throw new ProviderError("Cannot reach Google Gemini. Check your network connection.", "network", true);
          }
          if (!res.ok) throw await geminiError(res);
          if (!res.body) throw new ProviderError("Gemini returned an empty response.", "unknown", true);
          let text = "";
          let finish = "STOP";
          let blocked: string | null = null;
          let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          const reader = res.body.getReader();
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
                let evt: {
                  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
                  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
                  promptFeedback?: { blockReason?: string };
                };
                try {
                  evt = JSON.parse(line.slice(5).trim());
                } catch {
                  continue;
                }
                if (evt.promptFeedback?.blockReason) blocked = evt.promptFeedback.blockReason;
                const cand = evt.candidates?.[0];
                for (const p of cand?.content?.parts ?? []) {
                  if (!p.text || p.thought) continue; // thought summaries are not part of the answer
                  if (ttftMs === null) ttftMs = Date.now() - started;
                  markStarted();
                  text += p.text;
                  hooks?.onDelta?.(p.text);
                }
                if (cand?.finishReason) finish = cand.finishReason;
                if (evt.usageMetadata) {
                  usage = {
                    inputTokens: evt.usageMetadata.promptTokenCount ?? 0,
                    outputTokens: evt.usageMetadata.candidatesTokenCount ?? 0,
                    cacheReadTokens: evt.usageMetadata.cachedContentTokenCount ?? 0,
                    cacheWriteTokens: 0,
                  };
                }
              }
            }
          } catch (err) {
            if (err instanceof CancelledError || signal.aborted) throw new CancelledError();
            if (wd.stalled()) throw new ProviderError("Gemini stopped responding.", "timeout", true);
            throw new ProviderError("The connection to Gemini was interrupted.", "network", true);
          } finally {
            wd.signal.removeEventListener("abort", onAbort);
          }
          if (blocked || finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") {
            throw new ProviderError("Gemini declined to answer this request.", "refusal", false);
          }
          return { text, usage, model: this.opts.model, servedByFallback: null, ttftMs, stopReason: finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
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
      const res = await this.fetchImpl(`${this.base}/models?pageSize=200`, { headers: { "x-goog-api-key": this.opts.apiKey }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ok: false, message: (await geminiError(res)).message, latencyMs: null };
      const json = (await res.json().catch(() => ({}))) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const ids = (json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
      const found = ids.includes(this.opts.model);
      return {
        ok: found,
        message: found ? `Connected to Gemini (${this.opts.model}).` : `Connected, but model “${this.opts.model}” is not available to this key. Available: ${ids.slice(0, 8).join(", ")}`,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { ok: false, message: "Cannot reach Google Gemini.", latencyMs: null };
    }
  }
}

async function geminiError(res: Response): Promise<ProviderError> {
  const retryAfter = Number(res.headers.get("retry-after"));
  const ra = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  let reason = "";
  try {
    const j = (await res.json()) as { error?: { status?: string; message?: string; details?: { reason?: string }[] } };
    reason = `${j.error?.status ?? ""} ${j.error?.details?.map((d) => d.reason).join(" ") ?? ""}`;
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 400 && /API_KEY_INVALID/.test(reason)) return new ProviderError("Google rejected the Gemini API key. Update it in AI provider settings.", "auth", false);
  if (res.status === 401 || res.status === 403) return new ProviderError("This Gemini key does not have access. Check the key and that the Generative Language API is enabled.", "auth", false);
  if (res.status === 404) return new ProviderError("The selected Gemini model was not found. Choose another model.", "bad_request", false);
  if (res.status === 429) return new ProviderError("Gemini rate limit or quota reached.", "rate_limited", true, ra);
  if (res.status === 400) return new ProviderError(/too long|token/i.test(reason) ? "The request is too large for this Gemini model." : "Gemini rejected the request.", "bad_request", false);
  if (res.status >= 500) return new ProviderError("Gemini had a temporary error.", "overloaded", true, ra);
  return new ProviderError(`Gemini returned an error (${res.status}).`, "unknown", false);
}
