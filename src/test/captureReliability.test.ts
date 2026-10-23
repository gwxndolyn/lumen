// Capture lifecycle and pipeline reliability: idempotent controls, stale work from stopped runs or
// other sessions, bounded failure recovery, permission loss, adaptive sampling, OCR cancellation,
// transcript partial/final handling, and session isolation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveScreen, LiveScreenFatal, type TickResult } from "../core/liveScreen";
import { TesseractOcr, OcrCancelled } from "../core/ocr";
import type { CaptureInput } from "../core/app";
import { harness } from "./harness";

afterEach(() => vi.useRealTimers());

const frame = (n: number, fp?: number): CaptureInput => ({
  title: "Display 1",
  sourceId: "screen:1",
  vision: { mediaType: "image/jpeg", data: Buffer.from(`frame-${n}`).toString("base64") },
  ocrPng: Buffer.from(`png-${n}`),
  thumbnailDataUrl: "data:,",
  fingerprint: new Uint8Array(256).fill(fp ?? n * 37),
});

/** Advance fake timers and let promises settle. */
async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("live screen lifecycle", () => {
  const sampler = (tick: (run: number) => Promise<TickResult>, permitted = () => true) => {
    const states: string[] = [];
    const ls = new LiveScreen(tick, (s) => states.push(s.status), permitted);
    return { ls, states };
  };

  it("start is idempotent and never runs two capture loops", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { ls } = sampler(async () => (calls++, "captured"));
    ls.start(10);
    ls.start(10);
    ls.start(10);
    await flush(0);
    expect(calls).toBe(1);
    await flush(10_000);
    expect(calls).toBe(2);
    ls.stop();
    ls.stop();
    await flush(60_000);
    expect(calls).toBe(2);
    expect(ls.snapshot.status).toBe("inactive");
  });

  it("pause/resume semantics; pause while a capture is in flight discards its result", async () => {
    vi.useFakeTimers();
    let release!: (r: TickResult) => void;
    const { ls } = sampler(() => new Promise((r) => (release = r)));
    ls.start(5);
    await flush(0);
    ls.pause();
    expect(ls.snapshot).toMatchObject({ status: "paused", paused: true, active: true });
    release("captured");
    await flush(0);
    expect(ls.snapshot.captures).toBe(0); // the in-flight frame belonged to the paused run
    ls.resume();
    ls.resume();
    expect(ls.snapshot.status).toBe("active");
  });

  it("a slow capture is never overlapped (backpressure, not a queue)", async () => {
    vi.useFakeTimers();
    let concurrent = 0;
    let peak = 0;
    const { ls } = sampler(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 25_000)); // slower than the interval
      concurrent--;
      return "captured";
    });
    ls.start(5);
    await flush(120_000);
    expect(peak).toBe(1);
    ls.stop();
  });

  it("transient failures recover with bounded backoff; repeated failures stop with a reason", async () => {
    vi.useFakeTimers();
    let fail = 2;
    const { ls } = sampler(async () => {
      if (fail-- > 0) throw new Error("capture glitch");
      return "captured";
    });
    ls.start(5);
    await flush(0);
    expect(ls.snapshot).toMatchObject({ status: "recovering", failures: 1, effectiveIntervalSec: 10 });
    await flush(10_000);
    expect(ls.snapshot).toMatchObject({ status: "recovering", failures: 2, effectiveIntervalSec: 20 });
    await flush(20_000);
    expect(ls.snapshot).toMatchObject({ status: "active", failures: 0, captures: 1 });
    ls.stop();

    let calls = 0;
    const broken = sampler(async () => {
      calls++;
      throw new Error("no displays");
    });
    broken.ls.start(5);
    await flush(10 * 60_000);
    expect(calls).toBe(5);
    expect(broken.ls.snapshot).toMatchObject({ status: "failed", active: false });
    expect(broken.ls.snapshot.lastError).toMatch(/after 5 failed captures/);
  });

  it("an OS permission denial stops immediately as permission_required (no retry loop)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { ls } = sampler(async () => {
      calls++;
      throw new LiveScreenFatal("macOS is blocking screen capture.", "permission_required");
    });
    ls.start(5);
    await flush(60_000);
    expect(calls).toBe(1);
    expect(ls.snapshot).toMatchObject({ status: "permission_required", active: false, lastError: "macOS is blocking screen capture." });
  });

  it("consent revoked mid-run stops sampling", async () => {
    vi.useFakeTimers();
    let ok = true;
    let calls = 0;
    const { ls } = sampler(
      async () => (calls++, "captured"),
      () => ok,
    );
    ls.start(5);
    await flush(0);
    ok = false;
    await flush(5_000);
    expect(calls).toBe(1);
    expect(ls.snapshot.status).toBe("permission_required");
  });

  it("adaptive sampling slows down on an unchanged screen and snaps back on change or nudge", async () => {
    vi.useFakeTimers();
    let result: TickResult = "unchanged";
    const { ls } = sampler(async () => result);
    ls.start(5);
    await flush(0);
    for (let i = 0; i < 6; i++) await flush(ls.snapshot.effectiveIntervalSec * 1000);
    expect(ls.snapshot.effectiveIntervalSec).toBe(20);
    ls.nudge();
    expect(ls.snapshot.effectiveIntervalSec).toBe(5);
    result = "captured";
    await flush(500);
    expect(ls.snapshot.effectiveIntervalSec).toBe(5);
    ls.stop();
  });
});

describe("live screen in AppCore", () => {
  const withCapture = (fn: () => Promise<CaptureInput>) => {
    const h = harness();
    (h.core as unknown as { deps: { liveScreenCapture: unknown } }).deps.liveScreenCapture = fn;
    return h;
  };

  it("a capture still in flight when the session switches never lands in either session", async () => {
    let release!: (f: CaptureInput) => void;
    const h = withCapture(() => new Promise((r) => (release = r)));
    const a = h.core.activeSessionId;
    h.core.startLiveScreen();
    await new Promise((r) => setTimeout(r, 5));
    const b = h.core.createSession({ title: "B", type: "general" });
    expect(h.core.liveScreenState.active).toBe(false); // switching ended the run
    release(frame(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.core.engine.active(a).filter((r) => r.source === "screenshot")).toHaveLength(0);
    expect(h.core.engine.active(b.id).filter((r) => r.source === "screenshot")).toHaveLength(0);
    expect(h.core.liveScreenState.discarded).toBe(1);
  });

  it("a capture finishing after Stop is discarded", async () => {
    let release!: (f: CaptureInput) => void;
    const h = withCapture(() => new Promise((r) => (release = r)));
    h.core.startLiveScreen();
    await new Promise((r) => setTimeout(r, 5));
    h.core.stopLiveScreen();
    release(frame(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.core.engine.active(h.core.activeSessionId).filter((r) => r.source === "screenshot")).toHaveLength(0);
  });

  it("an unsupported platform reports 'unsupported' instead of pretending", () => {
    const h = harness();
    expect(() => h.core.startLiveScreen()).toThrow(/not supported/);
  });

  it("revoking screen consent cancels queued OCR and removes captures", async () => {
    let calls = 0;
    const h = harness({
      ocr: {
        recognize: async (_img: Buffer, signal?: AbortSignal) => {
          calls++;
          await new Promise((r) => setTimeout(r, 30));
          if (signal?.aborted) throw new OcrCancelled();
          return { text: "secret text", confidence: 0.9, ms: 30 };
        },
        dispose: async () => undefined,
      },
    });
    const { record, ocr } = h.capture("Bank");
    h.core.updateSettings({ consent: { screen: false } });
    await ocr;
    expect(h.core.engine.get(record.id)).toBeFalsy();
    expect(h.core.pipelineState().ocr.pendingJobs).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("OCR queue", () => {
  it("skips a job cancelled while waiting, and is bounded", async () => {
    const ocr = new TesseractOcr();
    const fakeWorker = { recognize: async () => (await new Promise((r) => setTimeout(r, 20)), { data: { text: "x", confidence: 90 } }), terminate: async () => undefined };
    (ocr as unknown as { worker: Promise<unknown> }).worker = Promise.resolve(fakeWorker);
    const ctrl = new AbortController();
    const first = ocr.recognize(Buffer.from("a"));
    const second = ocr.recognize(Buffer.from("b"), ctrl.signal);
    ctrl.abort();
    await expect(first).resolves.toMatchObject({ text: "x" });
    await expect(second).rejects.toBeInstanceOf(OcrCancelled);
    expect(ocr.cancelled).toBe(1);
    await expect(ocr.recognize(Buffer.from("c"), ctrl.signal)).rejects.toBeInstanceOf(OcrCancelled);
    const many = Array.from({ length: 6 }, () => ocr.recognize(Buffer.from("d")).catch((e: Error) => e.message));
    const out = await Promise.all(many);
    expect(out.filter((x) => typeof x === "string" && /busy/.test(x)).length).toBe(2); // MAX_PENDING = 4
  });
});

describe("transcription correctness", () => {
  it("interim text is never stored; finals are stored once, in order, with provider timestamps and confidence", () => {
    const h = harness();
    const live = h.core.startTranscript("Call");
    const ws = h.sockets[0]!;
    ws.open();
    ws.result("we should", false, 0, 0);
    ws.result("we should ship", false, 0, 0);
    expect(h.store.listSegments(live.id)).toHaveLength(0);
    ws.result("We should ship Thursday.", true, 0, 0);
    ws.result("We should ship Thursday.", true, 0, 0); // duplicate final (e.g. replay)
    ws.result("Agreed.", true, 3, 1);
    ws.result("Earlier remark.", true, 1.5, 1); // arrives late, belongs before "Agreed."
    const segs = h.store.listSegments(live.id);
    expect(segs.map((s) => s.text)).toEqual(["We should ship Thursday.", "Earlier remark.", "Agreed."]);
    expect(segs[0]!.confidence).toBeCloseTo(0.93);
    // Provider times (0 s, 1.5 s, 3 s) are kept relative to when the stream connected.
    const base = segs[0]!.startMs;
    expect(base).toBeLessThan(500);
    expect(segs.map((x) => x.startMs - base)).toEqual([0, 1500, 3000]);
    expect(h.transcript.filter((e) => e.type === "interim").length).toBe(2);
    h.core.stopTranscript();
  });

  it("stop is idempotent and releases the socket; a new session starts a new transcript", () => {
    const h = harness();
    const first = h.core.startTranscript("One");
    expect(h.core.startTranscript("One again").id).toBe(first.id); // start while running is a no-op
    h.sockets[0]!.open();
    h.core.stopTranscript();
    h.core.stopTranscript();
    expect(h.sockets[0]!.readyState).toBe(3);
    const b = h.core.createSession({ title: "B", type: "meeting" });
    const second = h.core.startTranscript("Two");
    expect(second.id).not.toBe(first.id);
    expect(h.core.transcriptContext(b.id)?.transcriptId).toBe(second.id);
  });
});

describe("context isolation and freshness", () => {
  it("one session's screen and notes never reach another session's request", async () => {
    const h = harness({ turns: [{ text: ["ok"] }, { text: ["ok"] }] });
    h.core.addText("note", "Project Falcon", "Falcon launch code is 7731.");
    await h.capture("Falcon dashboard").ocr;
    h.core.createSession({ title: "Other task", type: "general" });
    await h.ask("What is the launch code?");
    const body = JSON.stringify(h.calls.at(-1)!.body);
    expect(body).not.toContain("7731");
    expect(body).not.toContain("Falcon dashboard");
  });

  it("a newer live frame supersedes the older one; old screen context is marked stale, not current", async () => {
    let n = 0;
    const h = harness({ turns: [{ text: ["ok"] }] });
    (h.core as unknown as { deps: { liveScreenCapture: unknown } }).deps.liveScreenCapture = async () => frame(++n);
    h.core.startLiveScreen();
    await new Promise((r) => setTimeout(r, 30));
    const tick = (h.core as unknown as { liveScreenTick(r: number): Promise<TickResult> }).liveScreenTick.bind(h.core);
    const run = (h.core.liveScreen as unknown as { run: number }).run;
    await tick(run);
    const shots = h.core.engine.active(h.core.activeSessionId).filter((r) => r.source === "screenshot");
    expect(shots).toHaveLength(1);
    expect(shots[0]!.title).toMatch(/Live screen/);
    h.core.stopLiveScreen();
  });
});
