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

## Network destinations
- `api.anthropic.com` (HTTPS): question, attached context, retrieved passages, recent conversation turns.
- `api.deepgram.com` (WSS): audio, only while recording.

There is no telemetry, analytics, crash upload or update server. Each provider's API data-retention policy applies.

## Responsible use
Lumen does not implement content protection (`setContentProtection`), process disguise, or any evasion of proctoring or monitoring. The onboarding screen tells users to follow meeting, interview and exam rules and to tell participants about transcription.

## Known gaps
- The SQLite database is not encrypted at rest. Planned: SQLCipher, or field-level encryption with a key held in safeStorage.
- No code signing or notarization is configured, so packaged builds will trigger OS warnings.
- The prompt-injection detector is a heuristic; the structural controls are the real defence.
