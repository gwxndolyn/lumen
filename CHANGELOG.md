# Changelog

## 0.2.0 — 2026-10-21 (Phase 2: real-time copilot)
Context
- New `ContextEngine`. Each item is a normalized record carrying its source, timestamp, sourceId, confidence, permission, expiry and sensitivity.
- Items are deduplicated per session, ranked with BM25 plus recency and reliability, held to a size budget, and cited in answers.
- Text items are persisted; screen items stay in memory and expire on a TTL.
- Revoking a permission purges every item it gated.
- Sensitive data is masked before sending: card numbers (Luhn-checked), API keys, private keys, passwords, SSNs and JWTs.

Sessions
- New sessions feature, backed by database migration v4. Each session has a title, type, notes, context TTL and per-session model/effort/style.
- Sessions can be created, edited, switched, exported and deleted. Deleting cascades to all of the session's data, including its full-text index rows.
- Isolation is enforced in the engine, the database queries and the IPC layer.

AI
- New OpenAI-compatible provider (fetch + SSE).
- Stall watchdog, request-id dedupe, and at most one generation per conversation.
- Provider health state and a connection test. Retry counts and context-prep time are now tracked.
- 7 answer styles. A source-availability block, and a policy that the model must never describe sources that are absent. Evidence is labelled separately from inference.

Screen
- On-device Tesseract OCR, using the bundled model with no network calls.
- Image preprocessing.
- Captures wait for preview and confirmation before any question can use them.
- Blank or protected captures are detected and rejected.
- Image import; a capability report per platform; an explicit live screen mode.

Audio
- Mic and system audio are now separate channels (Deepgram `multichannel`) with You/Remote labels.
- Device status, level meters and a silence warning.
- Duplicate finals after a reconnect are suppressed. Timestamps stay correct across pauses.
- Memory-only transcripts; recovery actions shown when recording fails.

Knowledge
- DOCX support and folder import, both limited to what the user selects.
- Import report, hash dedupe, per-session scope, search UI.
- Retrieval now filters stopwords.

Overlay and UI
- Compact/expanded modes, position presets, anchored resize, remembered height.
- REC pause/stop, live-screen stop and provider-status pills.
- Keyboard map: ⌥1–7 answer style, ⌘⇧C copy, ↑ to recall the last question.
- New Sessions screen.
- UI audit fixed stale settings, unscoped search, and inputs that saved on every keystroke.

Engineering
- `AppCore` extracted; `electron/main.ts` is now a thin IPC layer.
- 132 tests, including the A–H workflow integration suite and a real-OCR test.
- oxlint added.
- The Electron smoke test now runs against wire-compatible Anthropic and Deepgram stand-ins, with real microphone audio.

## 0.1.0 — 2026-10-21
Initial release (overlay, Anthropic streaming, context, transcription, storage, 11 screens).
