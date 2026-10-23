// Reliability benchmark: a synthetic long session through the real AppCore pipeline (compiled
// core, in-memory SQLite, scripted OCR with a fixed per-frame cost, a fake transcription socket).
// Everything is SIMULATED workload — it measures Lumen's own pipeline, not real capture hardware.
//
//   npm run bench:reliability                      default (≈ 2 simulated hours of frames)
//   npm run bench:reliability -- --frames 3000 --out bench.json
//
// Prints JSON: frame throughput, OCR jobs run vs skipped, queue depth, transcript duplicates and
// drops, memory before/after GC, context items held, and cleanup after repeated session cycles.

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = (p) => import(path.join(root, "dist-electron/src", p));
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const FRAMES = Number(arg("--frames", 720)); // 720 frames × 10 s ≈ 2 h
const OCR_MS = Number(arg("--ocr-ms", 15));
const SEGMENTS = Number(arg("--segments", 3000));
const CYCLES = Number(arg("--cycles", 50));

const { AppCore } = await core("core/app.js");
const { Store } = await core("core/storage/db.js");
const { DEFAULT_SETTINGS } = await core("shared/defaults.js");
const { applySettingsPatch } = await core("shared/settingsSchema.js");
const { MockProvider } = await core("core/providers/mock.js");
const { DeepgramProvider } = await core("core/transcription/deepgram.js");

const gc = globalThis.gc ?? (() => undefined);
const heapMb = () => Math.round((process.memoryUsage().heapUsed / 1e6) * 10) / 10;
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);

let ocrRuns = 0;
let ocrPeak = 0;
let ocrInFlight = 0;
const ocr = {
  async recognize(_img, signal) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "OcrCancelled" });
    ocrInFlight++;
    ocrPeak = Math.max(ocrPeak, ocrInFlight);
    ocrRuns++;
    await new Promise((r) => setTimeout(r, OCR_MS));
    ocrInFlight--;
    return { text: `Screen text ${ocrRuns}`, confidence: 0.9, ms: OCR_MS };
  },
  async dispose() {},
};

class Sock {
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
}
const sockets = [];

let frameNo = 0;
let changeEvery = 3; // every 3rd frame differs; others are identical (idle screen)
const makeCore = () => {
  const store = new Store(":memory:");
  const settings = applySettingsPatch(DEFAULT_SETTINGS, { onboardingComplete: true, consent: { screen: true, microphone: true }, provider: { kind: "mock" }, screen: { requirePreview: false } });
  const c = new AppCore(
    {
      store,
      secrets: { get: (n) => (n === "deepgram" ? "dg" : null), has: (n) => n === "deepgram" },
      ocr,
      emitChat: () => undefined,
      emitTranscript: () => undefined,
      emitApp: () => undefined,
      providerFactory: () => new MockProvider(0),
      transcriptionFactory: (key) => new DeepgramProvider(key, (url, protocols) => (sockets.push(new Sock(url, protocols)), sockets.at(-1))),
      liveScreenCapture: async () => {
        frameNo++;
        const changed = frameNo % changeEvery === 0;
        const shade = changed ? (frameNo * 13) % 255 : 100;
        return {
          title: "Display 1",
          sourceId: "screen:1",
          vision: { mediaType: "image/jpeg", data: Buffer.alloc(40_000, frameNo % 251).toString("base64") },
          ocrPng: Buffer.alloc(20_000),
          thumbnailDataUrl: "data:,",
          fingerprint: new Uint8Array(256).fill(shade),
        };
      },
      localFetch: async () => {
        throw new TypeError("fetch failed");
      },
      devModeAllowed: true,
    },
    settings,
  );
  return { c, store };
};

// ---------- 1. sustained live-screen session ----------
gc();
const heap0 = heapMb();
const { c, store } = makeCore();
c.startLiveScreen();
const live = c.liveScreen;
// Drive ticks directly (no wall-clock waiting): call the real tick for the current run.
const tickLat = [];
const t0 = performance.now();
let captured = 0;
let unchanged = 0;
for (let i = 0; i < FRAMES; i++) {
  const s = performance.now();
  const r = await c.liveScreenTick(live["run"]);
  tickLat.push(performance.now() - s);
  if (r === "captured") captured++;
  else unchanged++;
}
const elapsed = performance.now() - t0;
c.stopLiveScreen();
// Let OCR for the last frame settle so it is counted in this phase, not the next.
await new Promise((r) => setTimeout(r, OCR_MS * 4));
const ocrScreenPhase = ocrRuns;
const ctxAfterScreen = c.engine.stats();

// ---------- 2. transcript stream with duplicates and out-of-order finals ----------
const t = c.startTranscript("Bench call");
const sock = sockets.at(-1);
sock.readyState = 1;
sock.onopen?.({});
let dupSent = 0;
const tsStart = performance.now();
for (let i = 0; i < SEGMENTS; i++) {
  const msg = (text, isFinal, start) =>
    sock.onmessage?.({ data: JSON.stringify({ type: "Results", is_final: isFinal, start, duration: 1, channel: { alternatives: [{ transcript: text, confidence: 0.9, words: [] }] } }) });
  msg(`partial ${i}`, false, i * 2);
  msg(`Sentence number ${i} about the release plan.`, true, i * 2);
  if (i % 10 === 0) {
    msg(`Sentence number ${i} about the release plan.`, true, i * 2); // replayed duplicate
    dupSent++;
  }
  if (i % 50 === 0 && i > 0) msg(`Late sentence ${i}.`, true, i * 2 - 1.5); // out of order
  if (i % 100 === 0) c.pushAudio(new Uint8Array(3200));
}
const tsMs = performance.now() - tsStart;
const segs = store.listSegments(t.id);
let ordered = true;
for (let i = 1; i < segs.length; i++) if (segs[i].startMs < segs[i - 1].startMs) ordered = false;
const texts = new Set();
let duplicates = 0;
for (const s of segs) {
  if (texts.has(s.text)) duplicates++;
  texts.add(s.text);
}
const pipe = c.pipelineState();
c.stopTranscript();

// ---------- 3. repeated session cycles ----------
gc();
const heapBeforeCycles = heapMb();
for (let i = 0; i < CYCLES; i++) {
  const s = c.createSession({ title: `cycle ${i}`, type: "general" });
  c.addText("note", "n", `note ${i} `.repeat(200));
  c.startLiveScreen();
  await c.liveScreenTick(c.liveScreen["run"]);
  c.stopLiveScreen();
  c.startTranscript(`t${i}`);
  c.stopTranscript();
  c.deleteSession(s.id);
}
gc();
const heapAfterCycles = heapMb();
const ctxAfterCycles = c.engine.stats();
await c.shutdown(500);
store.close();
gc();

const result = {
  kind: "lumen-reliability-benchmark",
  simulated: true,
  note: "Synthetic workload through the real AppCore pipeline; OCR and transcription are deterministic fakes. Not a measure of real capture hardware.",
  generatedAt: new Date().toISOString(),
  node: process.version,
  params: { frames: FRAMES, changeEvery, ocrMs: OCR_MS, segments: SEGMENTS, cycles: CYCLES },
  screen: {
    framesPerSec: Math.round((FRAMES / elapsed) * 1000),
    captured,
    unchanged,
    ocrRuns: ocrScreenPhase,
    ocrPeakConcurrent: ocrPeak,
    tickP50Ms: Math.round(pct(tickLat, 50) * 10) / 10,
    tickP95Ms: Math.round(pct(tickLat, 95) * 10) / 10,
    contextItemsAfter: ctxAfterScreen.items,
    imagesHeldAfter: ctxAfterScreen.images,
  },
  transcript: {
    finalsSent: SEGMENTS + Math.floor((SEGMENTS - 1) / 50),
    duplicatesSent: dupSent,
    stored: segs.length,
    duplicatesStored: duplicates,
    inOrder: ordered,
    eventsPerSec: Math.round(((SEGMENTS * 2 + dupSent) / tsMs) * 1000),
    bufferedAudioBytes: pipe.transcription?.bufferedAudioBytes ?? null,
    droppedChunks: pipe.transcription?.droppedChunks ?? null,
  },
  cycles: { count: CYCLES, heapBeforeMb: heapBeforeCycles, heapAfterMb: heapAfterCycles, contextItemsLeft: ctxAfterCycles.items, sessionsWithContextLeft: ctxAfterCycles.sessions },
  memory: { heapStartMb: heap0, heapEndMb: heapMb(), gcExposed: !!globalThis.gc },
};
console.log(JSON.stringify(result, null, 2));
const out = arg("--out");
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
