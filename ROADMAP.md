# Roadmap & status

Legend:
- ✅ implemented and verified (automated test and/or real-app smoke run on macOS arm64)
- 🟡 implemented and tested against stand-ins, but **not yet run against the real external service / hardware path**
- ⬜ not started

## Phase 2 audit (2026-10-21)

Findings from inspecting the v0.1 codebase before Phase 2:

| Area | v0.1 state | Problem | Phase 2 action |
|---|---|---|---|
| Context | `ContextStore`: in-memory list, global (not per session), screenshots only via `kind` | No normalization record, no permission/sensitivity/expiry per item, no OCR, everything sent | Replaced by **`ContextEngine`** (normalized records, per-session, TTL, permission-gated, sensitivity, confidence, persistence of text sources) |
| Sessions | None — one global history | Cross-task context could leak between unrelated tasks | **Sessions** (DB migration v4), with isolation enforced in the engine, the store queries and IPC |
| Screen | Capture + region picker; image sent to the model | No OCR, no preview gate, blank or protected captures not detected, no capability report, no image import | On-device **Tesseract OCR**, preview/confirm, blank detection, capability matrix, image import, explicit live mode |
| Audio | Mic and system audio **mixed into one mono stream**; no device state; dedupe absent | Mic and system audio not separable; replayed audio after a reconnect could duplicate finals | **Separate channels** (multichannel STT), per-channel labels, level meters, silence warning, duplicate suppression, pause-aware timestamps, memory-only mode |
| AI | Anthropic only; retry; cancel | Vendor lock-in; no stall detection; duplicate request ids not guarded; no per-conversation ordering guard | **OpenAI-compatible provider**, idle **watchdog**, request-id dedupe, busy guard, provider **health** state, retry counts |
| Answer modes | Short/detailed toggle | Did not meet the 7 required modes | 7 **answer styles** (quick, detailed, steps, suggest, technical, meeting summary, follow-ups) |
| Grounding | Citations | Model not told which sources are missing, so it could "summarize" an absent transcript | `<availability>` block plus a policy forbidding description of absent sources; evidence vs. inference labels |
| Knowledge | Global docs; PDF/text/HTML | Retrieval used stopwords (matched everything); no docx; no folder import; no import report; no dedupe | Stopword-filtered retrieval, **DOCX**, **folder import**, failure report, hash dedupe, per-session scope, search UI |
| Overlay | Auto-resize by content | No compact/expanded control, no presets, could grow off-screen, no recording controls, no provider status | Mode state machine, presets, anchored resize, remembered height, REC/pause/stop and status pills, keyboard map |
| UI audit | — | `Assistant` used the removed `length`; History searched all sessions; provider number inputs saved on every keystroke (invalid intermediate values threw) | Fixed; commit-on-blur inputs; every control wired; dead settings removed |
| Architecture | Logic in `electron/main.ts` (660 lines) | Workflows could not be integration-tested | **`AppCore`** (Electron-free); main is now a thin, validated IPC layer |

## Implementation checklist

### Context engine
- ✅ Normalized record (source, timestamp, content, sourceId, confidence, permission, expiry, sensitivity)
- ✅ Ingest → normalize → dedupe → rank (BM25 + recency + reliability) → bounded prompt → citations stored with the answer
- ✅ Expiration by source/session TTL; sweep every 60 s; pin to keep
- ✅ Revocation purges gated items
- ✅ Session isolation
- ✅ Sensitive-data masking
- ✅ Tests: dedupe, ranking, expiry, size limits, isolation, redaction

### Streaming AI
- ✅ Common `AIProvider` interface; Anthropic (official SDK, refusal fallback, prompt caching) and OpenAI-compatible (fetch + SSE)
- ✅ Incremental deltas; cancel; request-id dedupe; one generation per conversation; deltas matched by request id in the UI
- ✅ Timeouts, stall watchdog, rate limits, `retry-after`, exponential backoff (only before the first token)
- ✅ Health state and connection test (no secrets echoed); TTFT, total time, context-prep time, tokens, cost, retries
- 🟡 Real Anthropic API: the SDK is tested against a wire-compatible fake server; **no real key available in this environment**
- 🟡 Real OpenAI-compatible server (e.g. Ollama): tested against a fake; not run against a real server

### Screen understanding
- ✅ Explicit capture: screen under cursor, chosen screen/window, region, image import
- ✅ On-device OCR (Tesseract WASM, bundled English model, no network). Verified on a rendered image: 95% confidence, about 1–2 s
- ✅ Image preprocessing: vision JPEG ≤1568 px; OCR PNG normalized to 1.4–3k px
- ✅ Preview/confirm gate; blank or protected capture detection; clear controls; capability report
- ✅ Live screen context: explicit start/pause/stop, single rolling frame, indicator, stops on revocation
- 🟡 **Live OS screen capture on this Mac**: Screen Recording permission is **denied** for the test runner, so the desktopCapturer path is unverified here. The OCR → context → answer path was verified with the image-import route.

### Transcription
- ✅ Device selection, OS permission request, input status (device label, level, silence warning)
- ✅ Start/pause/resume/stop; interim vs. final; timestamps continuous across pause and reconnect; duplicate suppression; reconnect with audio buffer; auth failure stops with a "fix key" action
- ✅ Persist or memory-only per setting; retention
- ✅ **Real microphone capture verified**: the built-in MacBook Air microphone was opened in Electron (OS status granted, signal peak 0.098). In the full app smoke run, real mic PCM flowed through the worklet → IPC → `TranscriptSession` → WebSocket to a Deepgram-compatible stand-in.
- 🟡 Real Deepgram service: **no key available**; the wire format is implemented to Deepgram's documented API
- 🟡 System-audio loopback: implemented as a separate channel (`multichannel=true`); not exercised (needs a real meeting audio source)

### Contextual QA
- ✅ 7 answer styles; session type and tone; availability block; evidence vs. inference policy; "what's missing" behaviour; follow-ups use conversation history

### Overlay
- ✅ Compact/expanded (⌘E); drag and resize; position presets and custom; remembered size; multi-monitor follow-cursor; recovery after display changes (smoke: off-screen → back on screen)
- ✅ Keyboard map; scroll lock while reading; copy/selection; stop; REC pause/stop; live-screen stop; provider status; close is always reachable (✕, Esc, tray)

### Sessions
- ✅ Create/rename/switch/delete/export; type; notes (sent as pinned context); context TTL; per-session model/effort/style
- ✅ Isolation tests (engine, store, chat, transcript, knowledge, IPC ownership checks)

### Knowledge base
- ✅ Import files/folders (user-selected only); txt/md/code/csv/json/html/**pdf**/**docx**; chunking; metadata; hash dedupe; FTS5 BM25 search UI; passages cited as "knowledge base passage"; deletion removes chunks and index rows; failure report
- ⬜ Semantic/vector search. Deliberately not added: there is no local embedding model in the stack, and keyword BM25 is reliable and tested.

### Diagnostics
- ✅ TTFT, total, context prep, transcription latency, OCR time, error rate, retries, failures by code with fixes, cost, memory, CPU
- ✅ Configurable log level (off/error/info/debug); redaction; no content in logs

## Integration tests (required workflows)
`src/test/workflows.test.ts`, run through the real `AppCore`:

| | Workflow | Result |
|---|---|---|
| A | Question → stream → cancel (plus duplicate-request and ordering guards) | ✅ 3 tests |
| B | Capture → OCR → question uses the capture (preview gate, OCR wait, text-only mode, OCR failure, redaction) | ✅ 5 tests |
| C | Mic → transcription → contextual question (no-transcript honesty, separate channels, memory-only) | ✅ 4 tests |
| D | Import → search → grounded answer → delete index | ✅ 2 tests |
| E | Session switch isolation (notes, stale conversation id, in-flight cancel) | ✅ 4 tests |
| F | Revoke screen / mic / system audio | ✅ 4 tests |
| G | Provider disconnect → error → recovery (mid-stream drop, stall watchdog, STT reconnect without duplicates) | ✅ 4 tests |
| H | Session deletion removes stored and indexed data | ✅ 2 tests |

The Electron smoke test (`npm run smoke`) repeats A, B, C (with the real mic), E, F and H through the **real UI**, plus overlay modes, display recovery and all 12 screens.

## Test matrix

| Check | macOS 26 arm64 | Windows | Linux |
|---|---|---|---|
| Unit + integration (132 tests) | ✅ | ⬜ | ⬜ |
| Typecheck (strict, main + renderer) | ✅ | — | — |
| Lint (oxlint, warnings denied) | ✅ | — | — |
| Electron smoke (UI, stand-in services) | ✅ 7 of 8 runs passed; 1 early run failed with “Object has been destroyed” and was not reproduced in 7 reruns | ⬜ | ⬜ |
| Real microphone capture | ✅ | ⬜ | ⬜ |
| Real screen capture | ⬜ blocked: OS permission | ⬜ | ⬜ |
| Real Anthropic / Deepgram | ⬜ blocked: no credentials | ⬜ | ⬜ |
| Packaging / signing | ⬜ | ⬜ | ⬜ |

## Measured (macOS arm64, smoke run with local stand-ins; not real-model numbers)
- Context preparation: p50 0.4 ms
- Pipeline time to first token against the local stand-in: 10–26 ms. This is **app overhead only**, not model latency.
- OCR: 0.9–1.9 s per capture (first call includes worker start-up)
- Transcription latency (last audio frame → final segment, stand-in): 133 ms
- Memory: about 670 MB, all Electron processes (v0.1 measurement; not re-measured)

## Remaining
- ⬜ Run against real Anthropic, Deepgram and an OpenAI-compatible server; record real TTFT and cost
- ⬜ Grant Screen Recording permission and verify live capture, window capture and live screen mode
- ⬜ Investigate the intermittent smoke failure
- ⬜ Make the smoke stand-in cite the label of the source it actually used (it always cites C1)
- ⬜ Windows and Linux runs; packaging, signing, notarization, auto-update
- ⬜ DB encryption at rest; local Whisper STT provider; more OCR languages
