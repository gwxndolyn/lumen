# Security & Privacy

## Threat model

| Asset | Threat | Control | Tested |
|---|---|---|---|
| API keys | Leak via renderer, disk, logs or exports | Keys live only in the main process. They are encrypted with `safeStorage` (Keychain / DPAPI / libsecret); if that is unavailable they are kept in memory only. The renderer only sees booleans. Logs redact `sk-ant-…`, `Bearer`, `token=`. Exports exclude secrets. | `desktop.test.ts`, `providers.test.ts` (error messages exclude the key) |
| Renderer compromise via model output | XSS / script execution | `contextIsolation`, `sandbox`, `nodeIntegration: false`. Strict CSP (`script-src 'self'`). The Markdown renderer emits React elements only, never `innerHTML`, never `<img>`. Links are buttons; only `https:` opens, in the external browser. Navigation and `window.open` are blocked. | `markdown.test.tsx`; smoke test asserts `typeof require/process === undefined` |
| Prompt injection (screen text, documents, transcripts, clipboard) | Overriding policy / triggering actions | Untrusted content goes **only** inside an escaped `<context>` envelope in the user turn, never in the system prompt. Envelope tags are neutralized. Zero-width and bidi characters are stripped. A heuristic detector warns the user. **The model has no tools**, so it cannot act. | `context.test.ts` |
| IPC abuse | Arbitrary calls from untrusted frames | Every handler checks the sender URL is our bundled renderer. All arguments are zod-validated with length caps. Audio frames are size-capped. | via the smoke test |
| Sensitive capture | Undisclosed recording | All sources are off by default. Screen capture happens only on explicit action. The REC pill is always visible in the overlay, the tray (`● REC`) and the sidebar. Revoking consent stops recording and clears screenshots immediately. | manual |
| Data at rest | Over-retention | Configurable retention (default 90 d conversations / 30 d transcripts). Audio and screenshots are never written. Data can be exported and deleted (`secure_delete`, then `VACUUM`). The DB is protected by the OS user account; it is **not** encrypted at rest (see limitations). | `storage.test.ts` |
| Search | FTS query injection | Terms are tokenized and quoted, so operators cannot be injected | `storage.test.ts` |
| Settings | Prototype pollution / invalid values | `deepMerge` skips `__proto__` etc.; zod schema | `storage.test.ts` |

## Phase 2 additions

| Asset | Threat | Control | Tested |
|---|---|---|---|
| Cross-session data | One task's context leaking into another | Session-scoped engine, queries and IPC ownership checks. Chat is bound to the active session in main. In-flight answers are cancelled on switch. | `workflows.test.ts` E |
| Secrets on screen or clipboard | Sent to the provider by accident | Classification shown to the user. Masking (on by default) is applied to prompts, history and meeting notes. | `workflows.test.ts` B, `context.test.ts` |
| Screen capture | Unreviewed sensitive capture | Preview/confirm gate (default on); pending items are never sent. Blank or protected captures are rejected. No continuous capture unless the user starts it explicitly, with a visible indicator. | B, F, smoke |
| Revocation | Feature keeps using a revoked source | Screen: live capture stopped, items purged, late OCR results discarded. Mic: recording stopped, audio dropped at the main-process boundary. System audio: only that channel released. The OS media-permission handler checks the current consent. | F |
| OCR | Image upload for recognition | Tesseract runs as WASM in-process with the bundled model. No network calls. | `ocr.test.ts` |
| OpenAI-compatible endpoint | Key sent to the wrong host | The optional key is sent only to the configured base URL. Errors never echo the key. | `openaiCompat.test.ts` |
| Logs | Content leakage | Configurable level (off/error/info/debug). Metadata only, plus credential redaction. | `desktop.test.ts` |

## Network destinations
- `api.anthropic.com` (HTTPS): question, attached context, retrieved passages, recent conversation turns.
- `api.deepgram.com` (WSS): audio, only while recording.
- The configured OpenAI-compatible base URL, only when that provider is selected.

There is no telemetry, analytics, crash upload or update server. Each provider's API data-retention policy applies.

## Responsible use
Lumen does not implement content protection (`setContentProtection`), process disguise, or any evasion of proctoring or monitoring. The onboarding screen tells users to follow meeting, interview and exam rules and to tell participants about transcription.

## Known gaps
- The SQLite database is not encrypted at rest. Planned: SQLCipher, or field-level encryption with a key held in safeStorage.
- No code signing or notarization is configured, so packaged builds will trigger OS warnings.
- The prompt-injection detector is a heuristic; the structural controls are the real defence.
