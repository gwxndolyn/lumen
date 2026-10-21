import type { Effort, ErrorCode, ProviderTestResult } from "../../shared/types";

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
}

export interface StreamHooks {
  onDelta?: (text: string) => void;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** Common interface every model provider implements. */
export interface AIProvider {
  readonly kind: "anthropic" | "mock";
  /** True for development-mode providers whose output is not produced by a real model. */
  readonly isMock: boolean;
  generate(req: GenerateRequest, signal: AbortSignal, hooks?: StreamHooks): Promise<GenerateResult>;
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
