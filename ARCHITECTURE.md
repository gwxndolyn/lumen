# Architecture

## Stack decision
**Electron 44 + React 19 + TypeScript + Vite.** Tauri was considered. Electron was chosen because the required integrations come built in, with no native code to maintain:
- `desktopCapturer` for screen/window capture
- loopback system audio via `setDisplayMediaRequestHandler`
- `globalShortcut`
- `safeStorage` (OS keychain)
- `node:sqlite` with FTS5

The trade-off is memory: about 670 MB measured across all processes on macOS arm64.

## Process model
```
┌──────────────── Main process (Node, trusted) ────────────────┐
│ main.ts      IPC router (sender-URL check + zod validation)  │
│ ChatService  context gather → rank → prompt → provider      │
│ AnthropicProvider (official SDK, streaming, retry, fallback) │
│ TranscriptSession + DeepgramProvider (WebSocket)            │
│ Store (SQLite: migrations, FTS5, retention)                 │
│ ContextStore (in-memory session context, TTL)               │
│ SecretStore (safeStorage)   CaptureService   Logger         │
└──────────▲───────────────────────────────▲──────────────────┘
           │ contextBridge (typed LumenApi) │
┌──────────┴──────────┐         ┌──────────┴──────────────────┐
│ Overlay renderer    │         │ Main-window renderer        │
│ sandboxed, no Node  │         │ sandboxed, no Node          │
│ chat + AudioWorklet │         │ 11 screens                  │
└─────────────────────┘         └─────────────────────────────┘
```
API keys and provider calls exist **only** in the main process.

The overlay renderer also hosts audio capture. It is never destroyed, only hidden, and runs with background throttling disabled, so recording keeps going while the panel is hidden.

## Chat data flow
1. The renderer sends a `ChatSendRequest` over IPC. It is validated with zod.
2. Candidates are gathered:
   - enabled session context (notes, clipboard, documents, screenshots)
   - the live transcript, only if the user opted in for that question
   - FTS5 knowledge-base hits
   - FTS5 hits from past conversations
3. Candidates are normalized, deduplicated by content hash and ranked (BM25 × kind weight + recency + pin/explicit boosts). Low-relevance retrieved items are dropped.
4. The prompt is built:
   - **System** (trusted, cached): the policy prompt, plus mode, length and tone.
   - **User turn**: images, then a `<context>` envelope of `<source label="Cn">` blocks (escaped, budgeted to 60k chars and 3 images), then `<question>`.
   - Prior turns are sent as multi-turn history (last 12 turns, ≤24k chars).
5. `client.beta.messages.stream`:
   - `claude-opus-5-5` by default, with adaptive thinking and `effort: low` for low latency.
   - Server-side refusal fallback (`fallbacks: "default"`).
   - The top-level system block uses prompt caching.
6. Deltas → IPC → the renderer re-renders through the safe Markdown component.
7. The final message is persisted with the references the answer actually cited, plus cost and usage. Metrics are recorded.

**Retry policy:** our own exponential backoff with jitter. It honours `retry-after` and retries 429/5xx/529/network/timeouts, but **only before the first token**, so the user never sees duplicated text. SDK retries are disabled.

## Transcription flow
Audio goes through these steps:
1. `getUserMedia` (selected mic), plus optional `getDisplayMedia` loopback (video dropped).
2. An AudioWorklet downmixes, resamples to 16 kHz and converts to Int16.
3. 100 ms frames go over IPC (size-checked) to `TranscriptSession`.
4. `TranscriptSession` sends them to the Deepgram WebSocket (auth via subprotocol).

Results:
- Interim results are displayed and never stored.
- Final results are stored as segments with session-relative timestamps.
- On a drop, audio is buffered (ring-capped at 30 s) and the session reconnects with backoff.

## Storage
SQLite (`lumen.db` in userData). WAL mode, foreign keys and `secure_delete` are on. Migrations are append-only and tracked by `PRAGMA user_version`; each runs in a transaction. FTS5 external-content tables are kept in sync by triggers.

Settings live in the `kv` table. Secrets live in `secrets.json`, encrypted with safeStorage.

## Provider abstraction
`AIProvider` exposes `generate(req, signal, hooks)` and `test(model)`.
- Implementations: `AnthropicProvider` and `MockProvider`. The mock is explicit, bannered and returns `isMock: true`, which is shown everywhere.
- `TranscriptionProvider` is a separate interface with a `DeepgramProvider` implementation.
- Structured output uses `output_config.format`, validated again with zod.

## Key decisions
| Decision | Why |
|---|---|
| Local-first, no backend | Personal data stays on device. Keys sit in the OS keychain. A backend adds cost and attack surface with no current benefit. |
| Screenshots never persisted | Minimizes the sensitive data at rest |
| Untrusted context only in the user turn | Structural prompt-injection defence. The model has no tools. |
| Own Markdown renderer | No `innerHTML`, no images, no auto-links |
| `node:sqlite` | No native module rebuilds across Electron versions |
