import type { GenerateUsage } from "./types";

/** USD per million tokens. Source: Anthropic public pricing (cached 2026-10). Update when prices change. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Cache writes are billed at 1.25x the input rate (5-minute TTL). */
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostUsd(model: string, usage: GenerateUsage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const cost =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export function hasPricing(model: string): boolean {
  return model in PRICES;
}
