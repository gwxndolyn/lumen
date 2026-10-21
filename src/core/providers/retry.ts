import { CancelledError, ProviderError } from "./types";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 12_000 };

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number, opts: RetryOptions, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, opts.maxDelayMs * 2);
  const exp = opts.baseDelayMs * 2 ** (attempt - 1);
  const jitter = (opts.random ?? Math.random)() * opts.baseDelayMs;
  return Math.min(exp + jitter, opts.maxDelayMs);
}

/**
 * Retry `fn` with exponential backoff on retryable ProviderErrors.
 * `fn` receives a callback it must invoke once output has started streaming: after that point a
 * retry would duplicate text the user has already seen, so failures are surfaced instead.
 * Resolves with the result and the number of retries it took.
 */
export async function withRetry<T>(
  fn: (markStarted: () => void) => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = DEFAULT_RETRY,
  onRetry?: (attempt: number, delayMs: number, reason: string) => void,
): Promise<{ value: T; retries: number }> {
  const sleep = opts.sleep ?? abortableSleep;
  for (let attempt = 1; ; attempt++) {
    let started = false;
    try {
      const value = await fn(() => {
        started = true;
      });
      return { value, retries: attempt - 1 };
    } catch (err) {
      if (signal.aborted || err instanceof CancelledError) throw new CancelledError();
      const retryable = err instanceof ProviderError && err.retryable && !started;
      if (!retryable || attempt >= opts.maxAttempts) throw err;
      const delay = backoffDelay(attempt, opts, err.retryAfterMs);
      onRetry?.(attempt, delay, err.message);
      await sleep(delay, signal);
    }
  }
}
