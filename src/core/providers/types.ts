import type { Effort, ErrorCode, ProviderKind, ProviderTestResult } from "../../shared/types";

export type ProviderContentPart = { type: "text"; text: string } | { type: "image"; mediaType: "image/png" | "image/jpeg"; data: string };

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string | ProviderContentPart[];
}

export interface GenerateRequest {
  model: string;
  system: { text: string; cache: boolean }[];
  messages: ProviderMessage[];
  maxTokens: number;
  effort: Effort;
  timeoutMs: number;
  /** Abort and (if nothing streamed yet) retry when no stream event arrives for this long. */
  idleTimeoutMs?: number;
  /** When set, the provider must return JSON matching this schema (structured output). */
  jsonSchema?: Record<string, unknown>;
  /** Caller's retry policy (budget limits). Providers apply it on top of their own defaults. */
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  /** Total attempts including the first (1 = never retry). */
  maxAttempts: number;
  /**
   * Retry after a timeout. Off by default: a request that timed out may still have been processed
   * (and billed), so repeating it automatically can double the cost.
   */
  retryTimeouts: boolean;
}

/** What an adapter can do. Features are declared, never assumed to work the same everywhere. */
export interface ProviderCapabilities {
  /** Where inference runs. "local" = on this device; nothing leaves it. */
  location: "local" | "cloud" | "none";
  streaming: boolean;
  cancellation: boolean;
  vision: boolean;
  structuredOutput: "native" | "best_effort" | "none";
  /** Whether token usage comes from the provider or is unavailable. */
  usage: "reported" | "none";
  /** Context window in tokens, when known. */
  contextTokens: number | null;
}

export interface GenerateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: GenerateUsage;
  stopReason: string;
  model: string;
  /** Set when a server-side fallback model produced (part of) the answer. */
  servedByFallback: string | null;
  ttftMs: number | null;
  retries: number;
}

export interface StreamHooks {
  onDelta?: (text: string) => void;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** Common interface every model provider implements. */
export interface AIProvider {
  readonly kind: ProviderKind;
  /** True for development-mode providers whose output is not produced by a real model. */
  readonly isMock: boolean;
  readonly supportsImages: boolean;
  /** Declared capabilities. Adapters that predate this field are described by `capabilitiesOf`. */
  readonly capabilities?: ProviderCapabilities;
  generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult>;
  /** Cheap connectivity/credential check that never echoes secrets. */
  test(model: string): Promise<ProviderTestResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Combine the caller's abort signal with a stall watchdog. `kick()` must be called on every stream
 * event; if none arrives for `idleMs` the returned signal aborts and `stalled()` reports true so the
 * caller can raise a retryable timeout instead of treating it as a user cancel.
 */
export function idleWatchdog(parent: AbortSignal, idleMs: number | undefined) {
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => ctrl.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  if (parent.aborted) ctrl.abort();
  const kick = () => {
    if (!idleMs) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, idleMs);
  };
  kick();
  return {
    signal: ctrl.signal,
    kick,
    stalled: () => stalled,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

const CLOUD_CONTEXT: Partial<Record<string, number>> = { anthropic: 200_000 };

export function capabilitiesOf(p: AIProvider): ProviderCapabilities {
  if (p.capabilities) return p.capabilities;
  if (p.isMock) return { location: "none", streaming: true, cancellation: true, vision: p.supportsImages, structuredOutput: "none", usage: "none", contextTokens: null };
  return {
    // A custom OpenAI-compatible URL may be local or remote; treat it as leaving the device.
    location: "cloud",
    streaming: true,
    cancellation: true,
    vision: p.supportsImages,
    structuredOutput: p.kind === "openai_compat" ? "best_effort" : "native",
    usage: "reported",
    contextTokens: CLOUD_CONTEXT[p.kind] ?? null,
  };
}
