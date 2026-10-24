# Changelog

## Unreleased: response engine
Understanding
- New task types: code generation, code review, refactoring, summary, research, planning, notes. The user's instruction now decides the task ("Write a TypeScript function…" is code generation, not a TypeScript question).
- Questions about the latest versions, releases or news are flagged; the answer must say Lumen can't browse and how current its knowledge is.
- A bare "fix", "summarise", "thoughts?" with nothing to refer to now gets one clarifying question.
- Rules that never change with depth: no invented action-item owners, sources, URLs, dates or code locations.

Context
- A newer capture of the same window replaces the older one instead of both being sent.
- Earlier conversations are only included when they share real terms with the question, once per exchange, with the question they answered.
- Context is fitted to the model's context window; a request that still can't fit is refused before it is sent (all providers, not only local).
- Fixed: long sources could exceed their per-source budget by a few characters.

Checks (nothing is executed)
- Code blocks: JavaScript and TypeScript are parsed (TypeScript types are not checked), JSON is validated; other languages are shown as "not checked". Answers show "Code parses" or "Syntax error".
- Flags action-item owners not in the transcript, links not in your sources, and summaries without citations.
- More prompt-injection patterns: fake "User:/Assistant:" lines and requests to reveal keys or environment variables.

Measurement
- Diagnostics shows per-stage timings (plan, retrieve, rank, build, generate, verify) and the task type per request.
- Benchmark v1.1.0 (77 cases); new intent hold-out sets #4–#6.

## Unreleased: beta programme
Privacy fixes
- Pasted OpenAI project/service keys (`sk-proj-…`, `sk-svcacct-…`) and GitHub fine-grained/app tokens were not masked before context was sent to the AI provider. They are now (regression case `reg-001`).
- `lumen.log` did not redact OpenAI project keys, Gemini keys or GitHub tokens. The log, the support file and beta reports now share one credential list (`src/core/credentials.ts`).

Beta feedback
- **Send feedback** screen and **Report** under answers: category, description, impact, area, steps; opt-in diagnostics (last 24 h), usage summary and an editable question/answer excerpt. Drafts survive restarts; preview is required and is byte-for-byte the saved file; save failures are recorded and retryable. Nothing is uploaded.
- Support file: preview, 24-hour log window, 512 KB cap, data paths replaced, support-relevant settings included (no keys).
- Privacy → **Record usage events** (local only) switch and **Delete usage events**. New content-free milestones: first launch, onboarding completed, provider test result, context turned on, session restored, report/diagnostics exported, update check.

Team tooling (not shipped in the app)
- `npm run triage`: import and validate report files, prioritise, reproduce, de-duplicate, record fixes, regression tests and verification, with an audit log.
- Beta regression cases (`src/core/eval/regression-cases.json`): proposed → approved by a second reviewer → run by `npm run eval` and the release gate; edits after approval are not trusted.
- `npm run release:artifacts`: package-content validation, SHA-256 checksums, release manifest and notes; signing status observed, never assumed. The gate now records the commit, runs approved regression cases, and checks open security/privacy beta issues.

## Earlier: beta reliability
Context quality
- Oversized sources (long documents, big pastes) keep their opening plus the passages that match the question, in original order, with `[…]` marking omissions. Previously only the first 16k characters were sent, so a relevant passage later in the document never reached the model.
- Every timestamped source carries an `age`. Screen captures older than 5 minutes are marked `stale`, and the policy tells the model to prefer recent sources and to say when sources disagree.

Reliability
- Stop now takes effect during the wait for in-progress OCR. Previously it could wait up to 8 s, and a provider request could still be sent.
- An OCR engine that throws synchronously no longer leaves a capture stuck in "running".
- Shortcut-triggered screen captures (⌘⇧S, ⌘↵ with an empty box, Quick capture) are single-flight: rapid or repeated presses share one capture instead of hiding/showing the panel and capturing the screen repeatedly.
- Microphone/system-audio failure handling moved from the IPC layer into `AppCore` (now tested). A microphone failure says the transcript was kept.

Measurement
- New timings in Diagnostics: screen capture duration (p50), and stop → stopped (p50 and max).

Release gates
- `npm run smoke` previously always exited 0 (`… | grep … || true`). It now fails unless the app prints `SMOKE PASS`, and it honours `$TMPDIR`. This immediately exposed a stale `schemaVersion === 5` assertion, which now compares against the migration count.
- New `npm run check:secrets` (in CI and `release:check`) fails on real-looking API keys or private keys in tracked files. Obvious test placeholders are allowed.

Tests
- `src/test/beta.test.ts`: 30 end-to-end tests through the real AppCore → ChatService → Anthropic SDK (fake HTTP) → SQLite. They cover:
  - missing configuration, invalid credentials, unsupported model
  - rate limits, overload recovery, offline mode, malformed error bodies
  - cancellation during the OCR wait and on shutdown
  - rapid repeated activation
  - empty and irrelevant screen context
  - microphone denial and disconnection, system-audio loss, transcription auth failure
  - OCR crash recovery, live-screen tick failure
  - restart restore, legacy/corrupt settings, delete-everything
  - a 200-question / 3,000-segment long session with bounded growth
  - unexpected exceptions mid-stream
- Each new fix was checked by reverting it and confirming its test fails.

Docs
- New `docs/BETA.md`: setup, provider configuration, macOS/Windows permissions, session lifecycle, data retention, diagnostics, the pre-release smoke procedure and an honest platform matrix.
- README shortcuts updated to the actual defaults.

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
