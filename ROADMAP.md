# Roadmap & status

Legend:
- ✅ implemented, tested, and verified on macOS arm64
- 🟡 implemented and unit-tested, but not yet verified against a live service or on hardware
- ⬜ not started

## Phase 1 — Foundation
- ✅ Electron shell, overlay + main window, tray, single instance
- ✅ Design system (tokens, dark/light/system themes, focus states, reduced motion)
- ✅ Settings persistence with validation and repair
- ✅ Configurable global shortcuts with conflict detection

## Phase 2 — Core AI
- ✅ Provider abstraction; Anthropic via the official SDK; labelled mock provider
- ✅ Streaming, cancellation, retry-before-first-token, rate-limit handling, refusal fallback
- ✅ Conversation history, FTS search, rename/delete
- 🟡 Real Anthropic API round-trip. Tested against the real SDK with a fake HTTP backend that speaks the SSE wire format; **not yet exercised with a real key**. Use *AI provider → Test connection*.

## Phase 3 — Context
- ✅ Notes, clipboard, documents (txt/md/html/code/pdf text layer), knowledge base
- 🟡 Screenshot / window / region capture with vision. Code paths are built, but the smoke environment lacked macOS Screen Recording permission, so live capture is unverified.
- ✅ Ranking, dedupe, budgets, citations
- ⬜ OCR for scanned PDFs. Images go straight to the vision model; there is no local OCR step yet.

## Phase 4 — Audio
- 🟡 Live transcription (Deepgram nova-3): session logic, reconnect and buffering are unit-tested with a fake WebSocket. Not tested with a live key or microphone.
- 🟡 System-audio loopback (Windows, macOS 13+): implemented, unverified.
- ✅ Transcript UI, editing, meeting notes with structured output (validated)

## Phase 5 — Desktop copilot
- ✅ Floating overlay: opacity, always-on-top, compact/expanded, keyboard-first
- ✅ Multi-monitor placement and recovery (unit-tested geometry; recovery listeners on display events)
- ✅ Window and region selection UI

## Phase 6 — Production readiness
- ✅ Security review (SECURITY.md), structured redacted logging, diagnostics with measured metrics
- ✅ 82 automated tests, plus an Electron UI smoke test
- 🟡 Packaging config (electron-builder) present; not yet built or signed
- ⬜ Code signing and notarization; auto-update (electron-updater) strategy
- ⬜ DB encryption at rest
- ⬜ Additional providers: local Whisper STT, OpenAI-compatible LLMs
- ⬜ Optional encrypted sync / accounts

## Test matrix

| Check | macOS arm64 | macOS x64 | Windows 11 | Ubuntu 24.04 |
|---|---|---|---|---|
| Unit/integration (82) | ✅ pass | ⬜ | ⬜ | ⬜ |
| Typecheck | ✅ | — | — | — |
| Electron smoke (boot, isolation, shortcuts, overlay chat, 11 screens) | ✅ pass | ⬜ | ⬜ | ⬜ |
| Live Anthropic | ⬜ needs key | ⬜ | ⬜ | ⬜ |
| Live Deepgram + mic | ⬜ needs key | ⬜ | ⬜ | ⬜ |
| Screen capture | ⬜ needs permission | ⬜ | ⬜ | ⬜ (Wayland: portal) |
| System audio | ⬜ | ⬜ | ⬜ | n/a |
| Packaging | ⬜ | ⬜ | ⬜ | ⬜ |

## Measured performance (macOS arm64, mock provider, smoke run)
- TTFT: 40 ms (mock; this is pipeline overhead only, not model latency)
- End-to-end: 218 ms (mock)
- Memory: 672 MB, all Electron processes
- Real-model TTFT, transcription latency and cost per session have **not been measured yet**. The Diagnostics screen records them once keys are configured.

## Definition of done
A feature is ✅ only when:
- UI and main-process code work together
- loading, error and permission states are handled
- tests pass
- the security impact is reviewed
- it has been verified on the target platform
- its limitations are documented here
