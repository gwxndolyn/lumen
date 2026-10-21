import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ChatService } from "../core/chatService";
import { ContextStore } from "../core/context/contextStore";
import { Metrics } from "../core/metrics";
import { AnthropicProvider } from "../core/providers/anthropic";
import { MockProvider } from "../core/providers/mock";
import type { AIProvider } from "../core/providers/types";
import { Store } from "../core/storage/db";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { ChatEvent, ChatSendRequest } from "../shared/types";
import { fakeFetch, noSleep, type FakeTurn } from "./helpers";

function setup(opts: { turns?: FakeTurn[]; provider?: AIProvider | null; live?: string } = {}) {
  const store = new Store(":memory:");
  const context = new ContextStore();
  const metrics = new Metrics();
  const events: ChatEvent[] = [];
  const ff = fakeFetch(opts.turns ?? [{ text: ["Answer ", "[C1]"] }]);
  const client = new Anthropic({ apiKey: "sk-ant-test", fetch: ff.fetch as typeof fetch, maxRetries: 0 });
  const provider = opts.provider === undefined ? new AnthropicProvider({ apiKey: "x", client, retry: noSleep }) : opts.provider;
  const chat = new ChatService({
    store,
    context,
    metrics,
    getSettings: () => DEFAULT_SETTINGS,
    getProvider: () => provider,
    getLiveTranscript: () => (opts.live ? { title: "Standup", text: opts.live, startedAt: 0 } : null),
    emit: (e) => events.push(e),
  });
  return { store, context, metrics, events, chat, calls: ff.calls };
}

const base = (over: Partial<ChatSendRequest> = {}): ChatSendRequest => ({
  requestId: Math.random().toString(36).slice(2),
  conversationId: null,
  text: "What does the note say?",
  mode: "general",
  length: "short",
  tone: "neutral",
  includeLiveTranscript: false,
  ...over,
});

describe("ChatService end-to-end", () => {
  it("builds context, streams, persists, and records metrics", async () => {
    const t = setup();
    t.context.add({ kind: "note", title: "Release note", text: "The release ships Friday." });
    await t.chat.send(base());
    const types = t.events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types.filter((x) => x === "delta")).toHaveLength(2);
    expect(types.at(-1)).toBe("done");
    const start = t.events[0] as Extract<ChatEvent, { type: "start" }>;
    expect(start.references[0]!.title).toBe("Release note");
    const sent = t.calls[0]!.body as { messages: { content: { type: string; text: string }[] }[] };
    expect(sent.messages.at(-1)!.content.at(-1)!.text).toContain("The release ships Friday.");
    const msgs = t.store.listMessages(start.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.references.map((r) => r.label)).toEqual(["C1"]);
    expect(t.metrics.snapshot().requests[0]!.outcome).toBe("ok");
    expect(t.metrics.snapshot().sessionCostUsd).toBeGreaterThan(0);
  });

  it("sends prior turns as multi-turn history on follow-ups", async () => {
    const t = setup({ turns: [{ text: ["first"] }, { text: ["second"] }] });
    await t.chat.send(base({ text: "Q1" }));
    const cid = (t.events[0] as Extract<ChatEvent, { type: "start" }>).conversationId;
    await t.chat.send(base({ text: "Q2", conversationId: cid }));
    const msgs = (t.calls[1]!.body as { messages: { role: string; content: unknown }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[0]!.content).toBe("Q1");
    expect(msgs[1]!.content).toBe("first");
  });

  it("includes the live transcript only when requested", async () => {
    const t = setup({ turns: [{ text: ["a"] }, { text: ["b"] }], live: "[00:01] Speaker 1: we agreed on Tuesday" });
    await t.chat.send(base({ includeLiveTranscript: false }));
    await t.chat.send(base({ includeLiveTranscript: true }));
    const text = (i: number) => JSON.stringify(t.calls[i]!.body);
    expect(text(0)).not.toContain("we agreed on Tuesday");
    expect(text(1)).toContain("we agreed on Tuesday");
  });

  it("reports missing credentials without calling a provider", async () => {
    const t = setup({ provider: null });
    await t.chat.send(base());
    expect(t.events).toEqual([expect.objectContaining({ type: "error", code: "missing_credentials" })]);
    expect(t.store.counts().messages).toBe(0);
  });

  it("cancels mid-stream and keeps the partial answer marked as stopped", async () => {
    const t = setup({ turns: [{ text: Array.from({ length: 40 }, () => "tok "), delayMs: 5 }] });
    const r = base();
    const p = t.chat.send(r);
    await new Promise((res) => setTimeout(res, 40));
    expect(t.chat.cancel(r.requestId)).toBe(true);
    await p;
    const last = t.events.at(-1) as Extract<ChatEvent, { type: "cancelled" }>;
    expect(last.type).toBe("cancelled");
    const stored = t.store.getMessage(last.partialMessageId!)!;
    expect(stored.meta.cancelled).toBe(true);
    expect(stored.content.length).toBeGreaterThan(0);
    expect(t.metrics.snapshot().requests[0]!.outcome).toBe("cancelled");
  });

  it("retry regenerates the last answer without duplicating the question", async () => {
    const t = setup({ turns: [{ text: ["v1"] }, { text: ["v2"] }] });
    await t.chat.send(base({ text: "Q" }));
    const done = t.events.find((e) => e.type === "done") as Extract<ChatEvent, { type: "done" }>;
    await t.chat.send(base({ text: "", retryOfMessageId: done.messageId }));
    const cid = (t.events[0] as Extract<ChatEvent, { type: "start" }>).conversationId;
    expect(t.store.listMessages(cid).map((m) => m.content)).toEqual(["Q", "v2"]);
    const msgs = (t.calls[1]!.body as { messages: unknown[] }).messages;
    expect(msgs).toHaveLength(1);
  });

  it("surfaces network failures as retryable errors after exhausting retries", async () => {
    const t = setup({ turns: [{ networkError: true }] });
    await t.chat.send(base());
    expect(t.events.at(-1)).toMatchObject({ type: "error", code: "network", retryable: true });
    expect(t.metrics.snapshot().errorRate).toBe(1);
  });

  it("rejects empty questions", async () => {
    const t = setup();
    await t.chat.send(base({ text: "   " }));
    expect(t.events.at(-1)).toMatchObject({ type: "error", code: "bad_request" });
  });

  it("works end-to-end with the labelled mock provider", async () => {
    const t = setup({ provider: new MockProvider(0) });
    await t.chat.send(base());
    const start = t.events[0] as Extract<ChatEvent, { type: "start" }>;
    expect(start.provider.isMock).toBe(true);
    const msg = t.store.listMessages(start.conversationId)[1]!;
    expect(msg.meta.isMock).toBe(true);
    expect(msg.content).toContain("Development mode");
  });

  it("does not leak context from denied/disabled sources", async () => {
    const t = setup();
    const item = t.context.add({ kind: "clipboard", title: "secret", text: "password hunter2" });
    t.context.update(item.id, { enabled: false });
    await t.chat.send(base());
    expect(JSON.stringify(t.calls[0]!.body)).not.toContain("hunter2");
  });
});
