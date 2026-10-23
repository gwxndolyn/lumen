// Beta-readiness regressions: context quality on large/stale sources, single-flight screen capture,
// growth bounds in long sessions, and provider failures surfaced through the real AppCore pipeline.
import { describe, expect, it } from "vitest";
import { buildPrompt, formatAge } from "../core/context/promptBuilder";
import { rankCandidates } from "../core/context/ranker";
import { relevantExcerpt } from "../core/context/text";
import { harness } from "./harness";
import { sentText } from "./helpers";

const opts = { mode: "general" as const, style: "quick" as const, tone: "neutral" as const };

describe("context quality: large sources", () => {
  it("keeps a relevant passage that sits past the per-item cap", async () => {
    const h = harness();
    const filler = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} talks about unrelated budget planning items.`).join("\n");
    h.core.addText("document", "Spec", `Payments spec v3\n${filler}\nThe retry limit for the payment gateway is 7 attempts.`);
    await h.ask("What is the retry limit for the payment gateway?");
    const sent = sentText(h.calls[0]!.body);
    expect(sent).toContain("payment gateway is 7 attempts");
    expect(sent).toContain("Payments spec v3"); // opening kept for orientation
    expect(sent).toContain("[…]"); // omissions are marked, not hidden
    expect(sent).toMatch(/excerpt="relevant parts/);
    expect(sent.length).toBeLessThan(20_000); // still bounded by the per-item cap
  });

  it("falls back to plain truncation when nothing matches, and leaves short text untouched", () => {
    expect(relevantExcerpt("short", "anything", 100)).toEqual({ text: "short", excerpted: false });
    const r = relevantExcerpt("x ".repeat(5000), "zebra", 1000);
    expect(r.excerpted).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(1000 + "\n[truncated]".length);
    expect(r.text.endsWith("[truncated]")).toBe(true);
  });

  it("preserves the original order of selected passages", () => {
    const text = ["intro", ...Array.from({ length: 300 }, (_, i) => (i === 50 ? "alpha marker here." : i === 250 ? "beta marker here." : `noise line ${i} padding padding padding.`))].join("\n\n");
    const r = relevantExcerpt(text, "alpha beta marker", 3000);
    expect(r.text.indexOf("alpha marker")).toBeGreaterThan(-1);
    expect(r.text.indexOf("alpha marker")).toBeLessThan(r.text.indexOf("beta marker"));
  });
});

describe("context quality: timestamps and staleness", () => {
  const now = 1_700_000_000_000;
  it("labels every timestamped source with its age and flags old screen captures as stale", () => {
    const ranked = rankCandidates(
      "q",
      [
        { id: "a", kind: "ocr", title: "Old screen", text: "def foo(): return 1", createdAt: now - 20 * 60_000, explicit: true },
        { id: "b", kind: "ocr", title: "New screen", text: "def foo(): return 2", createdAt: now - 10_000, explicit: true },
        { id: "c", kind: "knowledge", title: "KB", text: "kb passage", createdAt: 0, retrieved: true },
      ],
      now,
    );
    const t = buildPrompt("which value does foo return?", ranked, { ...opts, now }).userContent.at(-1)!;
    const text = t.type === "text" ? t.text : "";
    expect(text).toMatch(/title="Old screen"[^>]*age="20 min ago"[^>]*stale="true"/);
    expect(text).toMatch(/title="New screen"[^>]*age="just now"/);
    expect(text).not.toMatch(/title="New screen"[^>]*stale=/);
    expect(text).not.toMatch(/title="KB"[^>]*age=/); // undated sources get no invented age
  });

  it("formats ages compactly", () => {
    expect(formatAge(5_000)).toBe("just now");
    expect(formatAge(3 * 60_000)).toBe("3 min ago");
    expect(formatAge(5 * 3_600_000)).toBe("5 h ago");
    expect(formatAge(72 * 3_600_000)).toBe("3 days ago");
  });
});

// ---------------- end-to-end failure paths (real AppCore → ChatService → Anthropic SDK → fake HTTP) ----------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent } from "../shared/types";
import { singleFlight } from "../core/singleFlight";
import { AppCore } from "../core/app";
import { Store } from "../core/storage/db";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { applySettingsPatch, loadSettingsJson } from "../shared/settingsSchema";
import { FakeOcr } from "./harness";
import type { OcrEngine } from "../core/ocr";

const terminal = (evts: ChatEvent[]) => evts.filter((e) => e.type === "done" || e.type === "error" || e.type === "cancelled");
const errorOf = (evts: ChatEvent[]) => evts.find((e) => e.type === "error") as Extract<ChatEvent, { type: "error" }> | undefined;

describe("first launch and provider configuration", () => {
  it("with no provider configured, a question ends with an actionable error and no network call", async () => {
    const h = harness({ provider: "none" });
    const evts = await h.ask("Hello?");
    expect(terminal(evts)).toHaveLength(1);
    expect(errorOf(evts)).toMatchObject({ code: "missing_credentials", retryable: false });
    expect(errorOf(evts)!.message).toMatch(/Settings → AI provider/);
    expect(h.calls).toHaveLength(0);
  });

  it("an invalid key fails fast (no retries), marks the provider down and never echoes the key", async () => {
    const h = harness({ turns: [{ status: 401, error: { type: "authentication_error", message: "invalid x-api-key sk-ant-test-0000000000" } }] });
    const evts = await h.ask("Hello?");
    expect(errorOf(evts)).toMatchObject({ code: "auth", retryable: false });
    expect(h.calls).toHaveLength(1);
    expect(h.core.health.state).toBe("down");
    expect(JSON.stringify(evts)).not.toContain("sk-ant-test");
  });

  it("an unsupported model is a non-retryable error that points at model settings", async () => {
    const h = harness({ turns: [{ status: 404, error: { type: "not_found_error", message: "model: nope" } }] });
    const evts = await h.ask("Hello?");
    expect(errorOf(evts)).toMatchObject({ code: "bad_request", retryable: false });
    expect(errorOf(evts)!.message).toMatch(/model/i);
    expect(h.calls).toHaveLength(1);
  });
});

describe("provider failures", () => {
  it("rate limit: honours retry-after, retries a bounded number of times, then reports it as retryable", async () => {
    const h = harness({ turns: Array.from({ length: 6 }, () => ({ status: 429, headers: { "retry-after": "0" }, error: { type: "rate_limit_error", message: "slow down" } })) });
    const evts = await h.ask("Q");
    expect(errorOf(evts)).toMatchObject({ code: "rate_limited", retryable: true });
    expect(h.calls.length).toBe(4); // DEFAULT maxAttempts in the harness retry policy
    expect(evts.filter((e) => e.type === "retrying")).toHaveLength(3);
    expect(h.core.health.state).toBe("degraded");
  });

  it("overloaded (529) recovers on retry before any text is shown", async () => {
    const h = harness({ turns: [{ status: 529, error: { type: "overloaded_error", message: "busy" } }, { text: ["Recovered"] }] });
    const evts = await h.ask("Q");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
    const deltas = evts
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(deltas).toBe("Recovered");
  });

  it("offline: every attempt fails with a network error and the conversation keeps only the question", async () => {
    const h = harness({ turns: [{ networkError: true }] });
    const evts = await h.ask("Q");
    const err = errorOf(evts)!;
    expect(err).toMatchObject({ code: "network", retryable: true });
    expect(h.store.listMessages(err.conversationId!).map((m) => m.role)).toEqual(["user"]);
  });

  it("a malformed (non-JSON) error body still produces one terminal error, never a hang", async () => {
    const h = harness();
    const bad = async () => new Response("<html>gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    (h.ff as { fetch: unknown }).fetch = bad;
    // Rebuild the provider with the broken fetch.
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { AnthropicProvider } = await import("../core/providers/anthropic");
    const { noSleep } = await import("./helpers");
    (h.core as unknown as { deps: { providerFactory: unknown } }).deps.providerFactory = () =>
      new AnthropicProvider({ apiKey: "x", client: new Anthropic({ apiKey: "x", fetch: bad as typeof fetch, maxRetries: 0 }), retry: noSleep });
    const evts = await h.ask("Q");
    expect(terminal(evts)).toHaveLength(1);
    expect(errorOf(evts)).toMatchObject({ code: "overloaded", retryable: true });
  });
});

describe("cancellation", () => {
  it("stop during the OCR wait ends the request immediately instead of after the wait", async () => {
    const slowOcr: OcrEngine = { recognize: () => new Promise((r) => setTimeout(() => r({ text: "late", confidence: 0.9, ms: 1 }), 1500)), dispose: async () => undefined };
    const h = harness({ ocr: slowOcr });
    h.capture("Slow");
    const p = h.core.send({ requestId: "c1", conversationId: null, text: "What is on screen?", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    h.core.chat.cancel("c1");
    await p;
    expect(performance.now() - t0).toBeLessThan(300);
    expect(h.chat.filter((e) => e.requestId === "c1").at(-1)).toMatchObject({ type: "cancelled" });
    expect(h.calls).toHaveLength(0); // no provider request after stop
    expect(h.core.metrics.snapshot().cancelP50Ms).not.toBeNull();
  });

  it("cancelling every request on shutdown leaves no request in flight", async () => {
    const h = harness({ turns: [{ text: Array.from({ length: 50 }, () => "x"), delayMs: 10 }] });
    const p = h.core.send({ requestId: "s1", conversationId: null, text: "long", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await new Promise((r) => setTimeout(r, 40));
    await h.core.shutdown(1000);
    await p;
    expect(h.core.chat.activeRequests).toBe(0);
    expect(terminal(h.chat.filter((e) => e.requestId === "s1"))).toHaveLength(1);
  });
});

describe("rapid repeated shortcut activation", () => {
  it("collapses concurrent captures into one and allows a new one afterwards", async () => {
    let runs = 0;
    const cap = singleFlight(async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return runs;
    });
    const results = await Promise.all([cap(), cap(), cap(), cap(), cap()]);
    expect(runs).toBe(1);
    expect(new Set(results)).toEqual(new Set([1]));
    expect(cap.inFlight).toBe(false);
    await cap();
    expect(runs).toBe(2);
  });

  it("a failing capture rejects every waiter once and does not wedge later attempts", async () => {
    let n = 0;
    const cap = singleFlight(async () => {
      if (++n === 1) throw new Error("capture interrupted");
      return "ok";
    });
    const both = await Promise.allSettled([cap(), cap()]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(await cap()).toBe("ok");
  });

  it("repeated assist presses with the same request id produce one generation", async () => {
    const h = harness({ turns: [{ text: ["one"], delayMs: 5 }] });
    const req = { requestId: "same", conversationId: null, text: "Q", style: "quick" as const, tone: "neutral" as const, includeLiveTranscript: false };
    await Promise.all(Array.from({ length: 8 }, () => h.core.send(req)));
    expect(h.calls).toHaveLength(1);
  });
});

describe("empty or irrelevant screen context", () => {
  it("a capture whose OCR found nothing is not presented as text, and availability stays truthful", async () => {
    const h = harness({ ocr: new FakeOcr("", 0), settings: { screen: { sendImages: false } } });
    const { ocr } = h.capture("Blank");
    await ocr;
    const evts = await h.ask("What does the screen say?");
    const start = evts.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;
    expect(start.availability.screen).toBe(0);
    expect(sentText(h.calls[0]!.body)).toContain("screen captures: none");
  });

  it("irrelevant retrieved history is dropped while the user's explicit capture is kept", async () => {
    const h = harness({ turns: [{ text: ["a"] }, { text: ["b"] }] });
    await h.ask("Tell me about sourdough fermentation");
    const { ocr } = h.capture("Code");
    await ocr;
    await h.ask("What is the total due on this invoice?", { conversationId: null });
    const sent = sentText(h.calls[1]!.body);
    expect(sent).toContain("Invoice 4471");
    expect(sent).not.toContain("sourdough");
  });
});

describe("audio permission denial and device loss", () => {
  it("microphone failure stops the recording once, keeps segments, and does not restart capture", () => {
    const h = harness();
    const live = h.core.startTranscript("Call");
    h.sockets[0]!.open();
    h.sockets[0]!.result("First point.", true, 0, 0);
    const starts = h.app.filter((e) => e.type === "audio-command" && e.command === "start").length;
    h.core.audioCaptureFailed("microphone", "permission denied");
    expect(live.status).toBe("stopped");
    expect(h.store.listSegments(live.id)).toHaveLength(1);
    expect(h.app.filter((e) => e.type === "audio-command" && e.command === "start").length).toBe(starts);
    expect(h.app.some((e) => e.type === "toast" && /Microphone capture failed/.test(e.message))).toBe(true);
    // A second report (e.g. track "ended" after denial) is harmless.
    h.core.audioCaptureFailed("microphone", "The microphone was disconnected.");
    expect(live.status).toBe("stopped");
  });

  it("system-audio failure keeps the microphone recording", () => {
    const h = harness();
    const live = h.core.startTranscript("Call", { systemAudio: true });
    h.sockets[0]!.open();
    h.core.audioCaptureFailed("system", "permission denied");
    expect(live.status).toBe("recording");
  });

  it("transcription auth failure ends the session with an error and asking still works without it", async () => {
    const h = harness();
    const live = h.core.startTranscript("Call");
    h.sockets[0]!.drop(1008, "unauthorized");
    expect(["error", "stopped"]).toContain(live.status);
    const evts = await h.ask("Anything?");
    expect(evts.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("screen capture interruption and recovery", () => {
  it("OCR engine crash marks the capture failed with a warning; the next capture works", async () => {
    const flaky: OcrEngine & { n: number } = {
      n: 0,
      recognize() {
        if (++this.n === 1) throw new Error("worker died"); // synchronous throw
        return Promise.resolve({ text: "Recovered text", confidence: 0.9, ms: 1 });
      },
      dispose: async () => undefined,
    };
    const h = harness({ ocr: flaky });
    const a = h.capture("A");
    await a.ocr;
    expect(h.core.engine.get(a.record.id)!.ocr).toBe("failed");
    expect(h.core.engine.get(a.record.id)!.warning).toMatch(/Text recognition failed/);
    const b = h.capture("B");
    await b.ocr;
    expect(h.core.engine.get(b.record.id)!.text).toBe("Recovered text");
  });

  it("live screen keeps running after a failed tick and reports the error", async () => {
    const h = harness();
    let n = 0;
    (h.core as unknown as { deps: { liveScreenCapture: unknown } }).deps.liveScreenCapture = async () => {
      if (++n === 1) throw new Error("display disconnected");
      return { title: "D", sourceId: "screen:1", vision: { mediaType: "image/jpeg" as const, data: "QQ==" }, ocrPng: Buffer.from("x"), thumbnailDataUrl: "data:," };
    };
    h.core.settings = { ...h.core.settings, screen: { ...h.core.settings.screen, liveIntervalSec: 3 } };
    h.core.startLiveScreen();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.core.liveScreenState.lastError).toMatch(/display disconnected/);
    expect(h.core.liveScreenState.active).toBe(true);
    h.core.stopLiveScreen();
  });
});

describe("restart, settings migration and data deletion", () => {
  it("restart restores the session, its open conversation and settings from disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-beta-"));
    const file = path.join(dir, "lumen.db");
    const boot = (store: Store) => {
      const settings = loadSettingsJson(store.getKv("settings"));
      return new AppCore(
        { store, secrets: { get: () => null, has: () => false }, ocr: null, emitChat: () => undefined, emitTranscript: () => undefined, emitApp: () => undefined, providerFactory: () => null },
        applySettingsPatch(settings, { onboardingComplete: true }),
        (s) => store.setKv("settings", JSON.stringify(s)),
      );
    };
    const s1 = new Store(file);
    const a = boot(s1);
    const sess = a.createSession({ title: "Interview prep", type: "interview" });
    a.updateSettings({ assistant: { tone: "formal" } });
    const conv = s1.createConversation(sess.id, "Q", "interview");
    a.setOpenConversation(conv.id);
    s1.close();

    const s2 = new Store(file);
    const b = boot(s2);
    expect(b.activeSessionId).toBe(sess.id);
    expect(b.openConversation()).toBe(conv.id);
    expect(b.settings.assistant.tone).toBe("formal");
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("settings from an older version or with corrupt fields load with defaults instead of failing", () => {
    const legacy = loadSettingsJson(
      JSON.stringify({ version: 1, assistant: { length: "detailed" }, interview: { autoSuggest: false }, privacy: { screenContextTtlMinutes: "lots" }, removedField: 1 }),
    );
    expect(legacy.assistant.style).toBe("detailed");
    expect(legacy.questions.policy).toBe("manual");
    expect(legacy.privacy.screenContextTtlMinutes).toBe(DEFAULT_SETTINGS.privacy.screenContextTtlMinutes);
    expect("removedField" in legacy).toBe(false);
    expect(loadSettingsJson("{not json").version).toBe(1);
  });

  it("ending capture and deleting all data stops recording, live screen and answers, and empties storage", async () => {
    const h = harness({ turns: [{ text: Array.from({ length: 40 }, () => "y"), delayMs: 10 }] });
    h.core.addText("note", "Secret note", "remember the launch code word: pineapple");
    const live = h.core.startTranscript("Call");
    h.sockets[0]!.open();
    h.sockets[0]!.result("Sensitive spoken line.", true, 0, 0);
    const p = h.core.send({ requestId: "d1", conversationId: null, text: "Q", style: "quick", tone: "neutral", includeLiveTranscript: false });
    await new Promise((r) => setTimeout(r, 30));
    h.core.deleteAll();
    await p;
    expect(live.status).toBe("stopped");
    expect(h.core.liveScreenState.active).toBe(false);
    expect(h.core.chat.activeRequests).toBe(0);
    const counts = h.store.counts();
    expect(counts.messages).toBe(0);
    expect(counts.transcripts).toBe(0);
    expect(counts.contextItems).toBe(0);
    expect(h.core.engine.list(h.core.activeSessionId)).toHaveLength(0);
    expect(h.app.some((e) => e.type === "audio-command" && e.command === "stop")).toBe(true);
  });
});

describe("long sessions stay bounded", () => {
  it("200 questions and 3,000 transcript segments: prompt size, context items and metrics stay capped", async () => {
    const h = harness({ turns: [{ text: ["ok ".repeat(200)] }] });
    const live = h.core.startTranscript("Marathon");
    h.sockets[0]!.open();
    for (let i = 0; i < 3000; i++) h.sockets[0]!.result(`Segment ${i} about topic ${i % 17} with some filler words to make it longer.`, true, i, i % 2);
    for (let i = 0; i < 80; i++) h.core.addText("note", `n${i}`, `note number ${i} unique ${Math.random()}`);
    let conv: string | null = null;
    const sizes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const evts = await h.ask(`Question ${i} about topic ${i % 17}?`, { conversationId: conv, includeLiveTranscript: true });
      const start = evts.find((e) => e.type === "start") as Extract<ChatEvent, { type: "start" }>;
      conv = start.conversationId;
      sizes.push(JSON.stringify(h.calls.at(-1)!.body).length);
    }
    expect(live.liveSegments().length).toBeLessThanOrEqual(2000);
    expect(h.core.engine.list(h.core.activeSessionId).length).toBeLessThanOrEqual(60);
    expect(h.core.metrics.snapshot().requests.length).toBeLessThanOrEqual(50);
    // Prompt growth plateaus: the last request is not meaningfully larger than the 30th.
    expect(sizes.at(-1)!).toBeLessThan(sizes[29]! * 1.25);
    expect(Math.max(...sizes)).toBeLessThan(200_000);
  }, 60_000);
});

describe("unexpected exceptions during generation", () => {
  it("a provider that throws a non-provider error mid-stream ends with one terminal error and keeps partial text", async () => {
    const h = harness();
    (h.core as unknown as { deps: { providerFactory: unknown } }).deps.providerFactory = () => ({
      kind: "anthropic",
      isMock: false,
      supportsImages: true,
      test: async () => ({ ok: true, message: "", latencyMs: 1 }),
      async generate(_req: unknown, _s: AbortSignal, hooks?: { onDelta?: (t: string) => void }) {
        hooks?.onDelta?.("Half an ans");
        throw new RangeError("boom inside parser");
      },
    });
    const evts = await h.ask("Q");
    expect(terminal(evts)).toHaveLength(1);
    const err = errorOf(evts)!;
    expect(err.code).toBe("unknown");
    expect(err.message).not.toMatch(/boom|RangeError/);
    const msgs = h.store.listMessages(err.conversationId!);
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: "Half an ans" });
    expect(msgs.at(-1)!.meta.interrupted).toBe(true);
  });

  it("an exception in the response planner does not block the answer", async () => {
    const h = harness();
    const orig = h.core.settings;
    // A corrupt personalization block makes planning throw; chat must still answer.
    h.core.settings = { ...orig, personalization: null as unknown as typeof orig.personalization };
    const evts = await h.ask("Q");
    h.core.settings = orig;
    expect(terminal(evts)).toHaveLength(1);
  });
});
