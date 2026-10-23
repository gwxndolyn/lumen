# Capture pipeline: lifecycle, limits and recovery

## Sources and their lifecycles

| Source | Where | States | Notes |
|---|---|---|---|
| One-off capture (screen / window / region / image) | `electron/capture.ts` → `AppCore.addCapture` | pending (preview) → active → expired | Held captures expire after 2 min; images live in memory only |
| Live screen | `src/core/liveScreen.ts` | inactive · active ⇄ paused · recovering · permission_required · unsupported · failed | Below |
| Live transcript | `src/core/transcription/session.ts` | idle · connecting · recording ⇄ paused · reconnecting · stopped · error | Below |
| OCR | `src/core/ocr.ts` | per capture: running → done / failed (cancelled jobs leave no state) | On-device Tesseract |

### Live screen
- `start()` is idempotent (a second start only updates the interval); `stop()`/`pause()`/`resume()`
  are safe to repeat. Each start/pause begins a new **run**; a capture still in flight when the
  user pauses, stops or switches session is discarded (`discarded` counter), never ingested.
- Live screen is bound to the session it was started in. Switching session stops it.
- A slow tick is never overlapped (backpressure). Unchanged screens are detected with a 16×16
  fingerprint and skipped (no OCR, no new item); after 3/6 unchanged frames the interval doubles /
  quadruples (≤ 60 s). A display change or wake (`nudge`) samples again within 0.5 s.
- Failures: up to 5 consecutive, with backoff `interval × 2^n` (≤ 60 s), state `recovering`; then
  `failed` with the last reason. An OS permission denial stops immediately as
  `permission_required` — no retry loop, no repeated prompts. Consent revoked in Lumen → stops.
- Each new frame replaces the previous live frame; OCR for the replaced frame is cancelled if it
  hasn't started.

### Transcript
Unchanged here (verified): interim text is shown but never stored; finals are de-duplicated
(replays after reconnect), kept in timestamp order, and stored with provider confidence and
timestamps relative to the stream start. Audio is buffered up to ~30 s while reconnecting (oldest
dropped beyond that, counted). Reconnect backoff 0.5→8 s, bounded attempts. Mic `ended` (device
unplugged) stops recording and keeps the transcript. Sleep pauses recording; wake asks the user to
resume. A crash while recording is recovered at next start (transcript closed at its last line).

### OCR
One worker, one job at a time, ≤ 4 waiting (more are rejected as "busy" — never an unbounded
queue), 30 s timeout per job (the worker is replaced after a timeout). Jobs can be cancelled before
they start (superseded live frame, consent revoked). An identical capture already in the session
reuses its OCR result instead of running again.

## Resource bounds

| Item | Bound |
|---|---|
| Context items per session | 60 (oldest unpinned evicted); text 200k chars per item |
| Screen images | memory only, never written to disk; expire with screen-context TTL (default 15 min) |
| Held captures (preview) | 2 min |
| Transcript buffer while offline | ~30 s audio |
| In-memory transcript segments | last 2,000 (all are persisted when saving is on) |
| OCR queue | 1 running + 4 waiting |
| Response cache | 100 entries / 2 MB, 10 min, memory only |
| Logs | 5 MB rotation, credentials redacted |
| Quality events / feedback | conversation retention setting |

## Privacy
Nothing about capture changed what leaves the device. Screen content goes only to the provider the
user chose (and is blocked from cloud providers when privacy restriction is on); a network failure
never routes to another provider unless the user enabled that fallback. Diagnostics contain counts
and states only (`AppCore.pipelineState()` → Diagnostics and the support file): no images, OCR text,
transcripts, prompts or keys.

## Tests and benchmark
- `npx vitest run src/test/captureReliability.test.ts` — lifecycle, races, backoff, permission loss,
  adaptive sampling, OCR cancellation and queue bounds, transcript finals/order, session isolation.
- `npm run bench:reliability [-- --frames 3000 --out bench.json]` — simulated long session through
  the real AppCore (fake OCR with fixed cost, fake transcription socket). Results are labelled
  `simulated: true`; they measure Lumen's pipeline, not capture hardware.

## Manual validation (real hardware — not automated)
1. macOS: deny Screen Recording in System Settings, start live screen → "permission is needed" with
   the System Settings path, no repeated prompt. Grant, restart Lumen, start again.
2. Start live screen, unplug/plug an external display → next frame within ~1 s, no error.
3. Start a transcript, unplug the USB mic → "Microphone capture failed" toast, transcript kept.
4. Start both, close the lid for 1 min, open → both paused, notices shown, Resume works.
5. Start a transcript, turn Wi-Fi off 20 s, on → "Reconnecting…", then recording; no duplicated lines.
6. Force-quit Lumen while recording, reopen → notice that the transcript was kept and ended.
Windows: steps 2–5 have not been run on Windows.
