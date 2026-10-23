// Phase 3 regression tests for the production audit findings (see PRODUCTION_AUDIT.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeEndpoint } from "../core/app";
import { importKnowledge } from "../core/knowledge";
import { Store } from "../core/storage/db";
import { DeepgramProvider } from "../core/transcription/deepgram";
import { TranscriptSession } from "../core/transcription/session";
import type { ChatEvent } from "../shared/types";
import { FakeSocket, harness } from "./harness";
import { sentText } from "./helpers";

describe("A-03 every request ends with exactly one terminal event", () => {
  it("emits an error (not a hang) when the database fails before generation starts", async () => {
    const h = harness();
    const real = h.store.getSession.bind(h.store);
    h.store.getSession = () => {
      throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
    };
    const evts = await h.ask("Hi");
    h.store.getSession = real;
    const terminal = evts.filter((e) => ["done", "error", "cancelled"].includes(e.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "error", code: "storage" });
    expect((terminal[0] as Extract<ChatEvent, { type: "error" }>).message).toMatch(/disk is full/);
    expect(h.core.chat.activeRequests).toBe(0);
  });

  it("treats an empty model answer as a retryable error and does not save it", async () => {
    const h = harness({ turns: [{ text: [] }] });
    const evts = await h.ask("Hi");
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "empty_response", retryable: true });
    const conv = (evts.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>).conversationId;
    expect(h.store.listMessages(conv).map((m) => m.role)).toEqual(["user"]);
  });

  it("reports truncation via stopReason so the UI can show a notice", async () => {
    const h = harness({ turns: [{ text: ["partial"], stopReason: "max_tokens" }] });
    const evts = await h.ask("Long question");
    expect(evts.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });
});

describe("A-07 development mode is never used silently in production builds", () => {
  it("refuses the mock provider when dev mode is not allowed", async () => {
    const h = harness({ provider: "mock" });
    (h.core as unknown as { deps: { devModeAllowed: boolean } }).deps.devModeAllowed = false;
    h.core.settings = { ...h.core.settings, provider: { ...h.core.settings.provider, kind: "mock" } };
    expect(h.core.providerFor()).toBeNull();
    const evts = await h.ask("Hi");
    expect(evts.at(-1)).toMatchObject({ type: "error", code: "missing_credentials" });
    h.core.settings = { ...h.core.settings, provider: { ...h.core.settings.provider, kind: "anthropic" } };
    expect(() => h.core.updateSettings({ provider: { kind: "mock" } })).toThrow(/not available/);
  });
});

describe("A-08 the open conversation survives a restart", () => {
  it("restores the last conversation per session and never across sessions", async () => {
    const h = harness({ turns: [{ text: ["a"] }] });
    const evts = await h.ask("Remember me");
    const conv = (evts.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>).conversationId;
    expect(h.core.openConversation()).toBe(conv);
    const other = h.core.createSession({ title: "B", type: "general" });
    expect(h.core.openConversation()).toBeNull();
    h.core.setOpenConversation(conv); // belongs to A: must be ignored
    expect(h.store.getLastConversation(other.id)).toBeNull();
  });
});

describe("A-21 daily spend limit", () => {
  it("blocks new requests once today's ledger reaches the limit, and the ledger stores no content", async () => {
    const h = harness({ settings: { provider: { dailySpendLimitUsd: 0.001 } }, turns: [{ text: ["one"], usage: { input: 5000, output: 500 } }, { text: ["two"] }] });
    const first = await h.ask("Q1");
    expect(first.at(-1)?.type).toBe("done");
    expect(h.core.spendToday().costUsd).toBeGreaterThan(0.001);
    const second = await h.ask("Q2");
    expect(second.at(-1)).toMatchObject({ type: "error", code: "spend_limit" });
    expect(h.calls).toHaveLength(1);
    const rows = h.store.db.prepare("SELECT * FROM usage_ledger").all();
    expect(JSON.stringify(rows)).not.toMatch(/Q1|one/);
  });
});

describe("A-18 endpoint overrides", () => {
  it("accepts https / wss and loopback http / ws only", () => {
    expect(safeEndpoint("https://gw.example.com", "http")).toBe("https://gw.example.com");
    expect(safeEndpoint("http://127.0.0.1:9000", "http")).toBe("http://127.0.0.1:9000");
    expect(safeEndpoint("http://evil.example.com", "http")).toBeUndefined();
    expect(safeEndpoint("wss://x.example.com/v1/listen", "ws")).toBeDefined();
    expect(safeEndpoint("ws://attacker.example.com/v1/listen", "ws")).toBeUndefined();
    expect(safeEndpoint("not a url", "http")).toBeUndefined();
  });
});

describe("A-11 / A-12 transcription backpressure and ordering", () => {
  function make() {
    const sockets: FakeSocket[] = [];
    const store = new Store(":memory:");
    const ws = store.createSession({ title: "W", type: "meeting" });
    const provider = new DeepgramProvider("k", (u, p) => {
      const s = new FakeSocket(u, p);
      sockets.push(s);
      return s;
    });
    const session = new TranscriptSession(provider, store, () => undefined, { workspaceSessionId: ws.id, language: "en", diarize: true, title: "t", channels: 2 });
    return { sockets, session, store };
  }

  it("stops sending into a congested socket, buffers in order, then drains", () => {
    const { sockets, session } = make();
    const s = sockets[0]!;
    s.open();
    (s as unknown as { bufferedAmount: number }).bufferedAmount = 1_000_000;
    const chunk = (n: number) => new Uint8Array(1000).fill(n);
    session.pushAudio(chunk(1));
    session.pushAudio(chunk(2));
    expect(s.sent).toHaveLength(0);
    expect(session.bufferedAudioBytes).toBe(2000);
    (s as unknown as { bufferedAmount: number }).bufferedAmount = 0;
    session.pushAudio(chunk(3));
    expect((s.sent as Uint8Array[]).map((c) => c[0])).toEqual([1, 2, 3]);
    expect(session.bufferedAudioBytes).toBe(0);
  });

  it("keeps segments chronological when channels finalize out of order", () => {
    const { sockets, session } = make();
    const s = sockets[0]!;
    s.open();
    s.result("later on mic", true, 5, 0, 0);
    s.result("earlier remote", true, 2, 0, 1);
    expect(session.liveSegments().map((x) => x.text)).toEqual(["earlier remote", "later on mic"]);
  });
});

describe("A-07 isolation: concurrent requests in different sessions never mix context", () => {
  it("two simultaneous questions get only their own session's context", async () => {
    const h = harness({ turns: [{ text: ["x", "y"], delayMs: 10 }] });
    const a = h.core.activeSessionId;
    h.core.addText("note", "A note", "alphamarker project details");
    const b = h.core.createSession({ title: "B", type: "general" }, false);
    h.core.engine.ingest({ sessionId: b.id, source: "note", title: "B note", text: "betamarker project details" });
    await Promise.all([
      h.core.send({ requestId: "ra", sessionId: a, conversationId: null, text: "project details?", style: "quick", tone: "neutral", includeLiveTranscript: false }),
      h.core.send({ requestId: "rb", sessionId: b.id, conversationId: null, text: "project details?", style: "quick", tone: "neutral", includeLiveTranscript: false }),
    ]);
    const bodies = h.calls.map((c) => sentText(c.body));
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((t) => t.includes("alphamarker"))).toHaveLength(1);
    expect(bodies.filter((t) => t.includes("betamarker"))).toHaveLength(1);
    expect(bodies.some((t) => t.includes("alphamarker") && t.includes("betamarker"))).toBe(false);
    // Each answer is stored in its own session's conversation.
    const startA = h.chat.find((e) => e.requestId === "ra" && e.type === "start") as Extract<ChatEvent, { type: "start" }>;
    const startB = h.chat.find((e) => e.requestId === "rb" && e.type === "start") as Extract<ChatEvent, { type: "start" }>;
    expect(h.store.getConversation(startA.conversationId)!.sessionId).toBe(a);
    expect(h.store.getConversation(startB.conversationId)!.sessionId).toBe(b.id);
  });

  it("expired context is excluded from later requests", async () => {
    let t = 1_700_000_000_000;
    const h = harness({ turns: [{ text: ["a"] }] });
    (h.core.engine as unknown as { now: () => number }).now = () => t;
    await h.capture().ocr;
    t += 16 * 60_000;
    await h.ask("What was on screen?");
    expect(sentText(h.calls[0]!.body)).not.toContain("1,250");
  });
});

describe("failed ingestion leaves nothing partially indexed", () => {
  it("rolls back a document whose chunk insert fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-fail-"));
    fs.writeFileSync(path.join(dir, "doc.md"), "partialmarker content");
    const store = new Store(":memory:");
    store.db.exec("CREATE TRIGGER boom BEFORE INSERT ON knowledge_chunks BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    const r = await importKnowledge(store, [path.join(dir, "doc.md")], null);
    expect(r.imported).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect(store.listKnowledgeDocs(null)).toHaveLength(0);
    expect(store.ftsCounts().chunks).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("credential changes", () => {
  it("replacing a key clears the old health result instead of keeping 'down'", async () => {
    const h = harness({ turns: [{ status: 401, error: { type: "authentication_error", message: "bad" } }] });
    await h.core.testProvider();
    expect(h.core.health.state).toBe("down");
    h.core.credentialsChanged();
    expect(h.core.health.state).toBe("unknown");
    expect(h.app.some((e) => e.type === "provider-health" && e.health.state === "unknown")).toBe(true);
  });
});
