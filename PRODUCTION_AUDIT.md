# Production audit — Lumen 0.2.0 → 0.3.0

Date: 2026-10-22.

Method: I read every non-test source file (`electron/`, `src/core`, `src/renderer`, `src/shared`, `scripts/`) and traced each workflow through the code. Then I ran probes against the real code (scripts and throwaway tests) and against the packaged app (`electron-builder --dir`, launched from `release/mac-arm64/Lumen.app`).

Status values:

| Status | Meaning |
|---|---|
| **V** | Fully implemented and verified |
| **T** | Implemented but insufficiently tested |
| **P** | Partial |
| **M** | Mocked or simulated |
| **B** | Broken |
| **X** | Missing |

The **Fixed in** column refers to the 0.3.0 work. A row with a dash is not fixed; see the remaining-gaps section.

## 1. Architecture inventory

| Component | Notes |
|---|---|
| Desktop shell | Electron 44. `electron/main.ts` is the IPC layer; `windows.ts`, `capture.ts`, `secrets.ts`, `logger.ts`. |
| Core | `src/core/app.ts` (`AppCore`, Electron-free), `ContextEngine`, `ChatService`, providers (Anthropic SDK, OpenAI-compatible, Mock), `TranscriptSession` + Deepgram, `TesseractOcr`, `LiveScreen`, `Store` (SQLite, schema v4). |
| Renderer | React 19. Overlay plus a 12-screen main window, behind a typed `contextBridge` API. |
| Backend / auth / sync | None. The app is local-first, bring-your-own-key. There are no accounts, so there is no authorization layer beyond IPC sender checks. |
| CI | **None** (finding A-20). |

## 2. Feature classification

| Feature | Status | Evidence / issue |
|---|---|---|
| Overlay chat, streaming, cancel | V | Workflow test A + smoke. |
| Duplicate request / ordering guards | V | Tests. |
| Answer styles, grounding policy | V | Tests (prompt content). Real-model answer quality is unverified (no key). |
| Anthropic provider | T | The SDK is exercised against a wire-compatible fake. **No live call has been made.** |
| OpenAI-compatible provider | T | Fetch-level fake only. |
| Development (mock) provider | **M** | Clearly labelled, but **selectable in production builds and offered in onboarding** (A-07). |
| Context engine (dedupe, rank, TTL, redaction) | V | Unit tests. |
| Session isolation | P | Engine, store and chat are isolated, but **`transcript:updateSegment` / `deleteSegment` IPC lack ownership checks** (A-02). Concurrent cross-session requests are untested. |
| Session deletion | **B** | Rows and FTS docsize entries are removed, but **deleted text remains readable in the `*_fts_data` segments on disk** (probe: the marker string is still present in `lumen.db` after delete + checkpoint) (A-01). |
| Knowledge import / search / delete | T | Transactional insert, but there is no test that a failure mid-insert leaves nothing behind. The same FTS residue applies (A-01). |
| Screen capture (OS) | T | Code path built. OS capture is unverified on this machine (Screen Recording permission denied for the runner). |
| OCR | V | Real Tesseract in unit tests **and inside the packaged app** (95%, about 1 s). |
| Live screen | T | Logic tests only. |
| Microphone capture | V | Real mic verified in Electron and in the smoke run. |
| System audio | T | Implemented. Not exercised with a real loopback source. |
| Transcription (Deepgram) | T | Wire stand-in only. **No backpressure: `WebSocket.send` buffers without bound** on a slow uplink (A-11). Interim text is shared across channels, so a final on one channel clears the other's interim (A-12). |
| Restart restores state | P | Settings, session, context and overlay bounds are restored. **The open conversation is not** (A-08). |
| Startup robustness | **B** | A corrupt `settings` kv value throws in `JSON.parse` inside `whenReady`, and a corrupt or unmigratable DB throws in `new Store()`. **Either way the app starts with no window, and the only trace is a log line** (A-04, A-05). |
| Chat error paths | **B** | `ChatService.send` calls `store.getSession()` *before* its `try`. Any DB error there rejects an un-awaited promise, so **the UI spins on "Preparing context…" forever** (A-03). Disk-full errors surface as the generic "Something went wrong" (A-14). |
| Empty or truncated model output | P | An empty answer is saved as an empty message. `max_tokens` truncation is not indicated (A-13). |
| Renderer crash | X | No `render-process-gone` handler. If the overlay renderer (the audio host) crashes, the main process still believes it is recording (A-09). |
| Sleep / resume | X | No `powerMonitor` handling (A-10). |
| Shutdown | P | `will-quit` closes the DB **while in-flight chat cancellations may still write to it** (A-15). |
| Secrets storage | P | Encrypted, but written with a non-atomic `writeFileSync`. A crash mid-write can corrupt every key, and decrypt failures are silent (A-16). |
| Migrations | P | Transactional, but **no backup is taken before migrating** a user's database (A-17). |
| Packaging | P | `--dir` bundle builds and launches (verified). Default Electron icon; no `author`; vulnerable dev-only code shipped inside the bundle (A-19); DMG not built; not signed or notarized. |
| CI / release checks | X | Missing (A-20). |
| Usage / cost limits | X | Cost is shown, but nothing caps it (A-21). |

## 3. Findings

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. "Fixed in" names the files changed.

| ID | Sev | Component | Finding | Remediation | Fixed in |
|---|---|---|---|---|---|
| A-01 | H | storage | Deleted messages, segments and chunks persist in FTS5 segment pages (`*_fts_data`). The privacy policy promises deletion. | Run FTS `optimize` and a WAL checkpoint after deletions; add a test that scans the on-disk bytes | `db.ts` |
| A-02 | M | IPC | Segment edit/delete do not check that the segment's transcript belongs to the active session | Ownership check plus regression test | `main.ts`, `db.ts` |
| A-03 | H | chat | Pre-`try` throw causes an infinite spinner and an unhandled rejection | Move all work inside `try`; always emit a terminal event | `chatService.ts` |
| A-04 | H | startup | A corrupt settings JSON crashes startup | Parse defensively and repair | `app.ts` / `main.ts` |
| A-05 | H | startup | A corrupt DB or failed migration crashes startup with no UI | `openStore()`: back up, quarantine corrupt files, start fresh with an explanatory dialog; never silently delete | `storage/open.ts`, `main.ts` |
| A-06 | M | security | `isTrustedUrl` trusts *any* `file://…/dist-renderer/index.html`; `LUMEN_DEV_URL` is honored in packaged builds | Exact-path match; ignore the dev URL when packaged | `windows.ts` |
| A-07 | M | product | Mock provider selectable in production | Packaged builds: dev mode only with `LUMEN_ALLOW_DEV_MODE=1`; hidden in UI; otherwise "unconfigured" | `app.ts`, `main.ts`, UI |
| A-08 | M | UX | The open conversation is lost on restart or panel reload | Persist the last conversation per session; restore it | `app.ts`, `hooks.ts` |
| A-09 | H | native | A renderer crash leaves recording state inconsistent and the overlay dead | Handle `render-process-gone`: stop audio-dependent recording, recreate the window, notify the user | `windows.ts`, `main.ts` |
| A-10 | M | native | Sleep/resume: recording and live screen continue in a bad state; display layout changes on wake | On suspend, pause recording and live screen and tell the user; on resume, re-clamp the overlay | `main.ts` |
| A-11 | M | audio | Unbounded WebSocket send buffer | Backpressure through `bufferedAmount`: divert to the bounded ring buffer and flush on drain | `deepgram.ts`, `session.ts` |
| A-12 | L | audio | One interim slot shared across channels; live segment order is arrival order | Interim per channel; insert segments sorted | `session.ts`, `hooks.ts` |
| A-13 | M | AI | Empty answers are saved; truncation is not shown | Error on empty answer; visible notice on `max_tokens` | `chatService.ts`, UI |
| A-14 | M | errors | Disk-full and DB errors surface as generic messages | Map SQLITE_FULL / ENOSPC / corrupt-DB errors to actionable messages | `errors.ts` |
| A-15 | M | shutdown | DB closed before in-flight work settles | `before-quit`: cancel, wait for settle (bounded), stop recording, then close | `main.ts`, `app.ts` |
| A-16 | M | secrets | Non-atomic writes; silent decrypt failure | Atomic temp-file + rename; surface decrypt failure in diagnostics | `secrets.ts`, `fsutil.ts` |
| A-17 | M | migrations | No pre-migration backup | Copy the DB before applying pending migrations; keep the last backup | `storage/open.ts` |
| A-18 | L | security | CSP allows `ws://localhost:*` with no use; endpoint overrides accept any URL | Drop it from CSP; overrides must be https or loopback, and are shown in diagnostics | `main.ts`, `app.ts` |
| A-19 | M | deps | `npm audit`: moderate DoS in `sprintf-js` via `mammoth → argparse`, which is only needed by mammoth's CLI and is shipped in the asar. electron-builder chain is build-time only. | Exclude it from the bundle; document the residual risk | `electron-builder.yml` |
| A-20 | M | process | No CI, no formatter, no release checklist; live tests not separated | GitHub Actions workflow, Prettier, `RELEASE_CHECKLIST.md`, `test:live` | `.github/`, `package.json` |
| A-21 | M | cost | No spend limit | Daily spend limit backed by a persisted usage ledger (no content) | `db.ts`, `chatService.ts` |
| A-22 | L | perf | Explicit large documents are sent whole on every question; history beyond 12 turns is silently dropped; redaction recomputed per request | Benchmark first, then chunk-level retrieval for large items, an abridged-history source, a cached prompt prefix, and bounded concurrency | `engine.ts`, `chatService.ts`, `anthropic.ts` |
| A-23 | L | OCR | Unbounded OCR job queue | Bound the queue (fail fast when busy) | `ocr.ts` |

## 4. Fake or simulated functionality sweep

| Pattern | Result |
|---|---|
| TODO / FIXME / HACK in source | None found. |
| Hardcoded demo responses | Only `MockProvider` (labelled) and `scripts/standins.mjs` (smoke-only). The mock is now gated in production builds (A-07). |
| Empty handlers / dead buttons | None found. All `onClick` handlers call real APIs. |
| Swallowed exceptions | 24 `catch` sites reviewed. Intentional and safe: logger I/O, socket close-after-close, abort cleanup, optional `res.json()`. **Problems:** silent secret decrypt failure (A-16) and silent kv-settings corruption (A-04). |
| Fake connection state | Provider health starts at "Not checked yet" and changes only on real results. |
| Mock data outside tests | None besides the mock provider. |

## 5. Remediation order
1. **Security and isolation:** A-01, A-02, A-06, A-18, A-19.
2. **Broken core workflows:** A-03, A-04, A-05, A-07, A-08, A-13.
3. **Native reliability:** A-09, A-10, A-11, A-12, A-15, A-23.
4. **AI latency and cost:** A-22, A-21 (benchmark first).
5. **Data integrity:** A-14, A-16, A-17.
6. **Packaging:** icon, metadata, DMG, packaged smoke.
7. **CI and release:** A-20.
8. **UX polish.**

The status of each finding after this release is recorded in `SECURITY_REVIEW.md` and in the final section below.

## 6. Status after 0.3.0 work

All findings A-01 to A-23 have been addressed. For each, a regression test or a verification run is listed in `SECURITY_REVIEW.md` / `RELEASE_CHECKLIST.md`.

The following remain unverified in this environment:
- **Live Anthropic, Deepgram and OpenAI-compatible calls.** No credentials. `npm run test:live` is ready to run when keys are present.
- **OS screen and window capture.** The runner's Screen Recording permission is denied.
- **System-audio loopback** with a real source.
- **Windows and Linux runtime.**
- **Code signing, notarization and auto-update.** No certificates or update host.
- **Clean-machine install.**
