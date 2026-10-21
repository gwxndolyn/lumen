import { describe, expect, it } from "vitest";
import { generateInsights } from "../core/meetingService";
import { MockProvider } from "../core/providers/mock";
import type { AIProvider } from "../core/providers/types";
import { Store } from "../core/storage/db";
import { DeepgramProvider, parseDeepgramMessage } from "../core/transcription/deepgram";
import { TranscriptSession } from "../core/transcription/session";
import type { SocketLike } from "../core/transcription/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { TranscriptEvent } from "../shared/types";

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  result(text: string, isFinal: boolean, start = 0, speaker?: number) {
    this.onmessage?.({
      data: JSON.stringify({ type: "Results", is_final: isFinal, start, duration: 1, channel: { alternatives: [{ transcript: text, words: speaker === undefined ? [] : [{ speaker }] }] } }),
    });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const store = new Store(":memory:");
  const events: TranscriptEvent[] = [];
  let now = 1_000_000;
  const provider = new DeepgramProvider("dg-key", (url, protocols) => {
    const s = new FakeSocket(url, protocols);
    sockets.push(s);
    return s;
  });
  const ws = store.createSession({ title: "W", type: "meeting" });
  const session = new TranscriptSession(provider, store, (e) => events.push(e), {
    workspaceSessionId: ws.id,
    language: "en",
    diarize: true,
    title: "Standup",
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    now: () => now,
  });
  return { sockets, timers, store, events, session, advance: (ms: number) => (now += ms) };
}

const pcm = (n = 3200) => new Uint8Array(n);

describe("Deepgram provider", () => {
  it("authenticates via subprotocol, not the URL", () => {
    const h = harness();
    const s = h.sockets[0]!;
    expect(s.protocols).toEqual(["token", "dg-key"]);
    expect(s.url).not.toContain("dg-key");
    expect(s.url).toContain("encoding=linear16");
    expect(s.url).toContain("sample_rate=16000");
  });

  it("parses results and majority speaker labels", () => {
    expect(parseDeepgramMessage("not json")).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: "Metadata" }))).toBeNull();
    const r = parseDeepgramMessage(JSON.stringify({ type: "Results", is_final: true, start: 2, duration: 1.5, channel: { alternatives: [{ transcript: " hi ", words: [{ speaker: 1 }, { speaker: 1 }, { speaker: 0 }] }] } }));
    expect(r).toEqual({ text: "hi", isFinal: true, startSec: 2, endSec: 3.5, speaker: "Speaker 2", channel: null, confidence: null });
  });
});

describe("TranscriptSession", () => {
  it("buffers audio until connected, then flushes in order", () => {
    const h = harness();
    h.session.pushAudio(pcm(10));
    h.session.pushAudio(pcm(20));
    expect(h.sockets[0]!.sent).toHaveLength(0);
    h.sockets[0]!.open();
    expect(h.sockets[0]!.sent.map((d) => (d as Uint8Array).byteLength)).toEqual([10, 20]);
    expect(h.session.status).toBe("recording");
  });

  it("stores only final results; interim results are shown, not saved", () => {
    const h = harness();
    h.sockets[0]!.open();
    h.sockets[0]!.result("hello wor", false);
    h.sockets[0]!.result("hello world", true, 0, 0);
    const segs = h.store.listSegments(h.session.id);
    expect(segs.map((s) => s.text)).toEqual(["hello world"]);
    expect(segs[0]!.speaker).toBe("Speaker 1");
    expect(h.events.some((e) => e.type === "interim")).toBe(true);
    expect(h.session.recentTranscript()).toContain("Speaker 1: hello world");
  });

  it("keeps timestamps continuous across pause/resume", () => {
    const h = harness();
    h.sockets[0]!.open();
    h.sockets[0]!.result("before", true, 0);
    h.session.pause();
    h.advance(10_000);
    h.session.resume();
    // Recognizer time only advanced 1 s of audio, but 10 s of wall time passed while paused.
    h.sockets[0]!.result("after", true, 1);
    const segs = h.store.listSegments(h.session.id);
    expect(segs[1]!.startMs - segs[0]!.startMs).toBeGreaterThanOrEqual(10_000);
  });

  it("pause drops audio; resume continues", () => {
    const h = harness();
    h.sockets[0]!.open();
    h.session.pause();
    h.session.pushAudio(pcm());
    expect(h.sockets[0]!.sent).toHaveLength(0);
    h.session.resume();
    h.session.pushAudio(pcm());
    expect(h.sockets[0]!.sent).toHaveLength(1);
  });

  it("reconnects after a network drop, buffering audio and keeping timestamps monotonic", () => {
    const h = harness();
    h.sockets[0]!.open();
    h.advance(5000);
    h.sockets[0]!.result("before", true, 4);
    h.sockets[0]!.drop();
    expect(h.session.status).toBe("reconnecting");
    h.session.pushAudio(pcm(100));
    const reconnect = h.timers.find((t) => t.ms === 500)!;
    h.advance(500);
    reconnect.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.open();
    expect(h.sockets[1]!.sent.map((d) => (d as Uint8Array).byteLength)).toEqual([100]);
    h.sockets[1]!.result("after", true, 0);
    const segs = h.store.listSegments(h.session.id);
    expect(segs.map((s) => s.text)).toEqual(["before", "after"]);
    expect(segs[1]!.startMs).toBeGreaterThanOrEqual(segs[0]!.startMs);
  });

  it("caps the reconnect buffer", () => {
    const h = harness();
    for (let i = 0; i < 2000; i++) h.session.pushAudio(pcm(3200));
    h.sockets[0]!.open();
    const total = h.sockets[0]!.sent.reduce<number>((s, d) => s + (d as Uint8Array).byteLength, 0);
    expect(total).toBeLessThanOrEqual(16_000 * 2 * 30);
  });

  it("stops with an error on auth rejection instead of retrying forever", () => {
    const h = harness();
    h.sockets[0]!.drop(1008, "");
    expect(h.events.at(-1)).toMatchObject({ type: "status", status: "error", action: "settings" });
    expect(h.session.status).toBe("error");
    expect(h.sockets).toHaveLength(1);
    expect(h.store.listTranscriptSessions(null)[0]!.endedAt).not.toBeNull();
  });

  it("gives up after max reconnects", () => {
    const h = harness();
    for (let i = 0; i < 7; i++) {
      h.sockets.at(-1)!.drop();
      h.timers.at(-1)?.fn();
    }
    expect(h.session.status).toBe("error");
  });

  it("stop closes the stream and ends the session", () => {
    const h = harness();
    h.sockets[0]!.open();
    h.session.stop();
    expect(h.session.status).toBe("stopped");
    expect(h.sockets[0]!.sent).toContain(JSON.stringify({ type: "CloseStream" }));
    h.session.pushAudio(pcm());
    expect(h.sockets).toHaveLength(1);
  });
});

describe("meeting insights", () => {
  it("validates structured output and persists it", async () => {
    const store = new Store(":memory:");
    const s = store.createTranscriptSession(store.createSession({ title: "W", type: "meeting" }).id, "Sync", "deepgram");
    store.addSegment({ sessionId: s.id, startMs: 0, endMs: 1000, speaker: "Speaker 1", channel: "mic", confidence: 0.9, text: "Alice will send the report by Monday." });
    const payload = {
      summary: "Alice will send the report.",
      keyPoints: ["Report due Monday"],
      actionItems: [{ task: "Send report", owner: "Alice" }],
      questionsToAsk: ["Which format?"],
      suggestedResponses: ["Thanks Alice"],
      followUpEmail: { subject: "Follow-up", body: "Hi all" },
    };
    let sentSchema: unknown;
    const fake: AIProvider = {
      kind: "anthropic",
      isMock: false,
      supportsImages: true,
      test: async () => ({ ok: true, message: "", latencyMs: 0 }),
      generate: async (req) => {
        sentSchema = req.jsonSchema;
        expect(JSON.stringify(req.messages)).toContain("Alice will send the report by Monday.");
        return { text: JSON.stringify(payload), model: "claude-opus-5-5", stopReason: "end_turn", servedByFallback: null, ttftMs: 1, retries: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const res = await generateInsights(fake, store, DEFAULT_SETTINGS, s.id, new AbortController().signal);
    expect(res.actionItems[0]!.owner).toBe("Alice");
    expect(sentSchema).toBeTruthy();
    expect(store.getInsights(s.id)).toMatchObject({ summary: payload.summary });
  });

  it("rejects malformed model output", async () => {
    const store = new Store(":memory:");
    const s = store.createTranscriptSession(store.createSession({ title: "W", type: "meeting" }).id, "Sync", "deepgram");
    store.addSegment({ sessionId: s.id, startMs: 0, endMs: 1, speaker: null, channel: "mic", confidence: null, text: "hi" });
    const bad: AIProvider = {
      kind: "anthropic",
      isMock: false,
      supportsImages: true,
      test: async () => ({ ok: true, message: "", latencyMs: 0 }),
      generate: async () => ({ text: '{"summary": 5}', model: "m", stopReason: "end_turn", servedByFallback: null, ttftMs: 1, retries: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    };
    await expect(generateInsights(bad, store, DEFAULT_SETTINGS, s.id, new AbortController().signal)).rejects.toThrow(/unexpected format/);
  });

  it("mock provider produces schema-valid, clearly labelled insights", async () => {
    const store = new Store(":memory:");
    const s = store.createTranscriptSession(store.createSession({ title: "W", type: "meeting" }).id, "Sync", "deepgram");
    store.addSegment({ sessionId: s.id, startMs: 0, endMs: 1, speaker: null, channel: "mic", confidence: null, text: "hi" });
    const res = await generateInsights(new MockProvider(0), store, DEFAULT_SETTINGS, s.id, new AbortController().signal);
    expect(res.isMock).toBe(true);
    expect(res.summary).toContain("[mock]");
  });

  it("refuses to summarize an empty transcript (never fabricates)", async () => {
    const store = new Store(":memory:");
    const s = store.createTranscriptSession(store.createSession({ title: "W", type: "meeting" }).id, "Empty", "deepgram");
    await expect(generateInsights(new MockProvider(0), store, DEFAULT_SETTINGS, s.id, new AbortController().signal)).rejects.toThrow(/empty/);
  });
});
