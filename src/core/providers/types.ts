import type { Effort, ErrorCode, ProviderKind, ProviderTestResult } from "../../shared/types";

export type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; data: string };

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
