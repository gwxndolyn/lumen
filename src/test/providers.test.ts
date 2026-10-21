import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../core/providers/anthropic";
import { MOCK_BANNER, MockProvider } from "../core/providers/mock";
import { estimateCostUsd } from "../core/providers/pricing";
import { backoffDelay, withRetry } from "../core/providers/retry";
import { CancelledError, ProviderError, type GenerateRequest } from "../core/providers/types";
import { fakeFetch, noSleep, type FakeTurn } from "./helpers";

function provider(turns: FakeTurn[]) {
  const ff = fakeFetch(turns);
  const client = new Anthropic({ apiKey: "sk-ant-test-0000000000", fetch: ff.fetch as typeof fetch, maxRetries: 0 });
  return { p: new AnthropicProvider({ apiKey: "unused", client, retry: noSleep }), calls: ff.calls };
}

const req: GenerateRequest = {
  model: "claude-opus-5-5",
  system: [
    { text: "policy", cache: true },
    { text: "mode", cache: false },
  ],
  messages: [{ role: "user", content: [{ type: "image", mediaType: "image/jpeg", data: "AAAA" }, { type: "text", text: "hi" }] }],
  maxTokens: 1000,
  effort: "low",
  timeoutMs: 5000,
};

describe("AnthropicProvider (integration via SDK + fake HTTP)", () => {
  it("streams deltas, returns usage, and sends the expected request shape", async () => {
    const { p, calls } = provider([{ text: ["Hel", "lo", " world"], usage: { input: 1234, output: 56 } }]);
    const deltas: string[] = [];
    const res = await p.generate(req, new AbortController().signal, { onDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(res.text).toBe("Hello world");
    expect(res.usage).toMatchObject({ inputTokens: 1234, outputTokens: 56 });
    expect(res.ttftMs).not.toBeNull();
    const body = calls[0]!.body as Record<string, any>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.stream).toBe(true);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.thinking).toBeUndefined();
    expect(body.fallbacks).toBe("default");
    expect(calls[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  });

  it("does not send fallbacks for Haiku (no server-side fallback)", async () => {
    const { p, calls } = provider([{ text: ["ok"] }]);
    await p.generate({ ...req, model: "claude-haiku-5-5" }, new AbortController().signal);
    expect((calls[0]!.body as Record<string, unknown>).fallbacks).toBeUndefined();
  });

  it("sends structured output schema when requested", async () => {
    const { p, calls } = provider([{ text: ['{"a":1}'] }]);
    await p.generate({ ...req, jsonSchema: { type: "object" } }, new AbortController().signal);
    expect((calls[0]!.body as Record<string, any>).output_config.format).toEqual({ type: "json_schema", schema: { type: "object" } });
  });

  it("reports when a fallback model served the answer", async () => {
    const { p } = provider([{ text: ["ok"], fallbackTo: "claude-opus-4-8" }]);
    const res = await p.generate(req, new AbortController().signal);
    expect(res.servedByFallback).toBe("claude-opus-4-8");
  });

  it("retries 429 with backoff then succeeds", async () => {
    const { p, calls } = provider([{ status: 429, error: { type: "rate_limit_error", message: "slow down" }, headers: { "retry-after": "0" } }, { text: ["done"] }]);
    const onRetry = vi.fn();
    const res = await p.generate(req, new AbortController().signal, { onRetry });
    expect(res.text).toBe("done");
    expect(res.retries).toBe(1);
    expect(calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("retries transient network failures before any output", async () => {
    const { p, calls } = provider([{ networkError: true }, { status: 529, error: { type: "overloaded_error", message: "x" } }, { text: ["ok"] }]);
    expect((await p.generate(req, new AbortController().signal)).text).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("does NOT retry after tokens were streamed (avoids duplicated output)", async () => {
    const { p, calls } = provider([{ text: ["partial ", "answer", "never"], dropAfter: 2 }, { text: ["second"] }]);
    await expect(p.generate(req, new AbortController().signal)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it("maps auth errors to a safe non-retryable message without leaking the key", async () => {
    const { p, calls } = provider([{ status: 401, error: { type: "authentication_error", message: "invalid x-api-key sk-ant-test-0000000000" } }]);
    const err = (await p.generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("sk-ant");
    expect(calls).toHaveLength(1);
  });

  it("maps refusals to a refusal error", async () => {
    const { p } = provider([{ text: [], stopReason: "refusal" }]);
    const err = (await p.generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(err.code).toBe("refusal");
  });

  it("maps context-too-large 400s", async () => {
    const { p } = provider([{ status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 2000000 tokens" } }]);
    const err = (await p.generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(err.code).toBe("context_too_large");
  });

  it("cancels mid-stream", async () => {
    const { p } = provider([{ text: Array.from({ length: 50 }, () => "x"), delayMs: 5 }]);
    const ctrl = new AbortController();
    const seen: string[] = [];
    const promise = p.generate(req, ctrl.signal, {
      onDelta: (t) => {
        seen.push(t);
        if (seen.length === 3) ctrl.abort();
      },
    });
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    expect(seen.length).toBeLessThan(10);
  });

  it("gives up after max attempts", async () => {
    const { p, calls } = provider([{ status: 500, error: { type: "api_error", message: "x" } }]);
    const err = (await p.generate(req, new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(noSleep.maxAttempts);
  });
});

describe("MockProvider", () => {
  it("is explicitly labelled as mock and never claims to be AI", async () => {
    const m = new MockProvider(0);
    expect(m.isMock).toBe(true);
    const res = await m.generate(
      { ...req, messages: [{ role: "user", content: '<context>\n<source label="C1" kind="user note" title="JD">x</source>\n</context>\n\n<question>\nWhat?\n</question>' }] },
      new AbortController().signal,
    );
    expect(res.text.startsWith(MOCK_BANNER)).toBe(true);
    expect(res.text).toContain("[C1] user note: JD");
    expect(res.model).toBe("mock");
  });
});

describe("retry & pricing", () => {
  it("backoff grows exponentially and is capped", () => {
    const o = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(a, o))).toEqual([100, 200, 400, 800, 1000]);
    expect(backoffDelay(1, o, 3000)).toBe(2000);
  });

  it("withRetry reports how many retries it took", async () => {
    let n = 0;
    const r = await withRetry(async () => {
      if (n++ < 2) throw new ProviderError("x", "network", true);
      return "ok";
    }, new AbortController().signal, noSleep);
    expect(r).toEqual({ value: "ok", retries: 2 });
  });

  it("withRetry stops immediately on cancellation", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(withRetry(async () => Promise.reject(new ProviderError("x", "network", true)), ctrl.signal, noSleep)).rejects.toBeInstanceOf(CancelledError);
  });

  it("estimates cost from published per-MTok prices", () => {
    expect(estimateCostUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(6, 6);
    expect(estimateCostUsd("unknown", { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});
