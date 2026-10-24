# Lumen beta guide

This guide is for developers and beta testers. It describes what the current build actually does. If something here doesn't match what you see, file it as a bug.

## 1. Prerequisites

| | |
|---|---|
| Node | 22.5 or newer (`.nvmrc` pins the CI version; developed on Node 24.15) |
| OS | macOS 13+ (arm64 verified). Windows 10/11 x64 builds and runs its unit tests in CI, but the app has **not** been exercised by hand on Windows (see §9). Linux builds but is unsupported for the beta. |
| AI provider | An API key for Anthropic, OpenAI or Google Gemini, or an OpenAI-compatible endpoint |
| Transcription (optional) | A Deepgram API key. Without one, everything except live transcripts works. |

## 2. Run locally

```bash
npm ci
npm start          # build + launch
```

On first launch, onboarding opens in the main window. Packaged builds hide development (mock) mode unless `LUMEN_ALLOW_DEV_MODE=1` is set, so a build never answers with simulated output by accident.

## 3. Configure an AI provider

1. Open *Settings → AI provider*. Pick a provider and model, paste the key, then press **Test connection**.
2. Possible results:
   - **Connected**: ready.
   - **Down**: the key was rejected or the model is unavailable. Fix it before asking.
   - **Degraded**: a network problem, rate limit or provider outage. Retrying usually works.
3. Keys are encrypted with the OS keychain (macOS Keychain / Windows DPAPI via Electron `safeStorage`) in `secrets.json` in the data folder. They are never written to logs or settings. If OS encryption is unavailable, keys are kept in memory for the current run only.
4. For development only, `ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY` environment variables can supply keys. These are never persisted.
5. Optional: set a **daily spend limit**. Lumen refuses new requests once the estimated spend recorded locally for the day reaches it.

## 4. Permissions

Screen, microphone and system-audio context are all **off by default**. Turn each on under *Permissions*. Turning one off immediately stops that capture and deletes the context it produced.

| | macOS | Windows |
|---|---|---|
| Screen | System Settings → Privacy & Security → **Screen Recording** → enable Lumen, then **restart Lumen** (macOS only applies the grant after a restart). A denied permission produces a clear error rather than a repeated prompt. | No OS permission. Windows with display affinity (DRM video, some password managers) capture black and are rejected. |
| Microphone | macOS prompts once. If you deny it, re-enable it in System Settings → Privacy & Security → Microphone. Lumen doesn't re-prompt. | Settings → Privacy & security → Microphone → allow desktop apps. |
| System audio | Loopback through the screen-capture permission | Loopback, no extra permission |

## 5. A session, end to end

1. **Start.** The overlay appears top-centre. Press ⌘/Ctrl+\\ to show or hide it without stealing focus.
2. **Add context** (only what you have authorized):
   - ⌘/Ctrl+Shift+S captures the display under the cursor. The panel hides itself during the capture.
   - ⌘/Ctrl+Shift+A attaches copied text.
   - Live transcript: *Transcript → Start*.
   - Live screen: *Capture → Live screen*, which samples periodically, skips unchanged frames and keeps one rolling frame.
3. **Ask.**
   - ⌘/Ctrl+Enter submits typed text. With an empty box, it asks about whatever authorized context exists.
   - Answers stream. Esc or ⌘/Ctrl+Shift+Backspace stops one.
   - Retry and Copy are on each answer. Follow-ups continue the same conversation.
4. **Status.**
   - The header shows provider health, "● REC" while recording, and "▣ Live screen" while sampling.
   - On macOS the tray title shows the same.
   - Each answer lists the context sources it used.
5. **Stop.**
   - Stop the transcript and live screen from the panel, the tray, or by revoking the permission.
   - Quitting stops all capture, cancels in-flight answers and waits up to 1.5 s for them to save.
6. **Delete.**
   - *Sessions → Delete* removes a session's conversations, transcripts, notes, documents, context and their search-index entries.
   - *Privacy → Delete everything* removes all of it.
   - Both compact the full-text index and checkpoint the WAL so deleted text does not linger on disk (`src/test/deletion.test.ts` scans the raw database bytes).

## 6. Data and privacy

| Data | Where | Retention |
|---|---|---|
| Conversations | `lumen.db` (SQLite) in the data folder | 90 days by default (*Privacy*) |
| Transcripts | `lumen.db` (only if "save transcripts" is on) | 30 days by default |
| Screenshots | **Memory only**, never written to disk | 15 min screen-context TTL |
| Notes / clipboard / documents added as context | `lumen.db` | Session TTL, or until removed |
| Logs | `lumen.log` (5 MB, one rotation) | Operational metadata only. No prompts, answers, transcripts or screen text. Keys are redacted. |

Data folder:
- macOS: `~/Library/Application Support/Lumen`
- Windows: `%APPDATA%\Lumen`
- Override: `LUMEN_USER_DATA`

**What leaves the device:** only the question, the context items selected for it (ranked, deduplicated, size-bounded, with sensitive values such as card numbers and keys masked when redaction is on), and the recent turns of that conversation. These go to the provider you configured. Audio goes to Deepgram only while a transcript is recording.

**Untrusted content:** screen text, documents and transcripts are placed in a labelled `<context>` envelope in the user turn, never in the system prompt. Text that looks like instructions to the AI is flagged and treated as data. The model has no tools and cannot act on your computer.

## 7. Diagnosing problems

*Diagnostics* shows:
- provider health
- permission state
- shortcut registration (including conflicts)
- per-stage timings: time to first token, total, context prep, OCR wait, input → request sent, transcription, OCR, screen capture, stop → stopped
- memory, and failures by error code

**Preview support file** shows exactly what **Save support file** writes: the app version, OS and architecture, schema version, support-relevant settings (no keys), health, routing mode, quality counts (success rate, failures by code, feedback counts) and operational log lines from the last 24 hours (capped at 512 KB), with keys, data paths and your home folder scrubbed. It contains no questions, answers, context or feedback notes.

**Send feedback** (sidebar, or **Report** under an answer) is the beta feedback form: category, description, optional impact/area/steps, and opt-in diagnostics, usage summary or an editable question/answer excerpt. Preview the exact file, save it, and send it to your beta contact — Lumen never uploads it. How the team triages reports into fixes and regression tests: `docs/BETA_PROGRAMME.md`.

| Symptom | Cause / fix |
|---|---|
| "No API key is configured…" | Add a key in *Settings → AI provider* |
| "The … API key was rejected" | Key revoked or mistyped. Replace it. Lumen doesn't retry auth failures. |
| "Rate limited…" / "overloaded" | Lumen retries up to 3 times with backoff (honouring `retry-after`) **before** any text appears (configurable: *AI provider → Usage limits → Attempts per request*). After that, press Retry. |
| "The AI provider timed out" | Not retried automatically (the request may already have been processed and billed). Press Retry, or allow *Retry after a timeout*. |
| "Privacy restriction keeps … on this device" | Privacy restriction is on and no local model can take the request. Set up a local model, remove that context, or allow it to go to the cloud. |
| "The connection … was interrupted" mid-answer | The partial answer is kept and marked incomplete. Retry regenerates it. |
| "The capture came back blank" (macOS) | Screen Recording permission is not active yet. Grant it and restart Lumen. |
| Live screen "stopped: screen capture permission is needed" | The OS blocked capture. Grant Screen Recording (macOS), restart Lumen, start it again. Lumen doesn't retry this automatically. |
| Live screen "Retrying after a failed capture" / "stopped after 5 failed captures" | Transient capture failures are retried with backoff; after 5 in a row it stops and shows the last reason. Press Start to try again. |
| Live screen "checking every 20s/40s" | The screen hasn't changed, so Lumen samples less often. It returns to your interval as soon as something changes. |
| "Lumen closed while recording" notice | The previous run ended mid-recording; the transcript was kept up to its last line. |
| "Microphone capture failed" | Device unplugged or permission denied. Recording stops and the transcript so far is kept. |
| Shortcut shows "conflict" | Another app owns it. Rebind it in *Settings → Shortcuts*. |
| "Lumen started with a fresh database" | The old database was corrupt or a migration failed. It was moved aside (not deleted), and its path is in the dialog. |

## 8. Feedback and quality (beta testers)

- Under any answer, **Feedback** → Helpful / Incorrect / Incomplete / Irrelevant context / Too slow / Too verbose / Incorrect formatting / Other, with an optional note and expected answer. It is stored **only on this computer** with the answer's metadata (task type, provider, model, route, timings, answer-check results) — not the question, answer or context. Secrets you type are masked.
- *Quality* (sidebar) shows metrics computed from recorded events (requests, success and cancel rates, latency p50/p95, failures by error, answer-check flags, feedback), your feedback (inspect, delete), **proposals** (recurring problems with evidence; nothing below 5 occurrences; under 30 is marked preliminary), and **My test cases**.
- **Create test case** turns flagged feedback into an evaluation case: you review and edit it first; the question is redacted; context is not copied. It joins a local "My cases" collection, separate from the shipped benchmark, runs in the Evaluation Lab, and keeps its last result.
- Events and feedback follow the conversation-retention setting and are removed by *Delete everything*. Nothing is uploaded; to share, export the support file or a run and send it yourself.

## 9. Tests and quality gates

```bash
npm run typecheck        # strict TS, main + renderer
npm run lint             # oxlint, warnings are errors
npm test                 # unit + integration (real AppCore, SQLite, Anthropic SDK over a fake HTTP backend, fake STT socket)
npm run check:secrets    # no real-looking keys in tracked files
npm run audit:prod       # advisories in code that actually ships
npm run smoke            # real Electron app + UI vs local Anthropic/Deepgram stand-ins and the real mic
npm run release:check    # all of the above except smoke
npm run eval             # deterministic intelligence benchmark (64 cases)
npm run bench:reliability # simulated long-session benchmark of the capture pipeline (docs/CAPTURE_RELIABILITY.md)
npm run release:gate     # everything, recorded in release-report.json, with a READY / NOT READY verdict
npm run test:live        # real providers; needs ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPGRAM_API_KEY
```

`npm run smoke` exits non-zero unless the app prints `SMOKE PASS`. It needs a display, permission to bind 127.0.0.1, and a working microphone. It cannot run headless in CI.

### Release gate

`npm run release:gate -- --baseline <recorded-run.json>` runs type check, lint, tests, secret scan, audit, build, the deterministic benchmark (compared with the baseline), the Electron smoke test and — if `ANTHROPIC_API_KEY` is set — live provider tests. It writes `release-report.json` with each check's actual result. A critical check that **fails or could not run** makes the verdict NOT READY; it is never counted as passed. With all critical checks passing the verdict is *READY FOR BETA*; it becomes *READY FOR RELEASE CANDIDATE* only when live provider tests also ran and passed. Code signing is never checked by the gate. Baseline thresholds are the recorded run itself: any regressed case blocks.

### Pre-release smoke procedure (run before every beta build, ~10 min)

1. `npm run release:gate -- --baseline <last release-benchmark.json>`: must exit 0 (READY FOR BETA or better).
2. (included in 1) `npm run smoke`: must print `SMOKE PASS`.
3. `npm run package:mac` (or `package:win` on Windows), then `npm run smoke:packaged`: must print `SMOKE PASS`.
4. Manual, in the packaged app with a **real** key (this is the only step that touches real services):
   1. Fresh profile: `LUMEN_USER_DATA=$(mktemp -d) <app>`. Onboarding appears. Configure the provider; **Test connection** shows *Connected*.
   2. Ask a question. It streams. Press Esc mid-answer: it stops within about a second, and the partial answer is kept.
   3. Enable screen context. Press ⌘/Ctrl+Shift+S **five times quickly**: exactly one capture is added.
   4. Ask "what is on my screen?". The answer cites `[C1]`.
   5. Start a transcript, speak a sentence, ask about it. Unplug or disable the mic: a "Microphone capture failed" toast appears and the transcript is kept.
   6. Turn off Wi-Fi and ask: a network error appears with Retry. Turn Wi-Fi on and press Retry: it succeeds.
   7. Quit and relaunch: the session and open conversation are restored.
   8. *Privacy → Delete everything*: Sessions, History and Transcript are empty.
5. Record the results (pass/fail per step, OS version, build) in the release notes.

## 10. Platform status and known limitations

Verified on **macOS 26 arm64** only:
- unit and integration suite
- Electron smoke test (real UI, real mic, real OCR)
- packaged `--dir` build

Still requires a person on the other platform or with credentials:

| Area | macOS | Windows |
|---|---|---|
| Unit / integration tests | ✅ run locally | ⏳ in CI (`windows-latest`); not yet observed passing because the branch has not been pushed |
| Electron smoke (UI, mic, OCR) | ✅ | ⬜ not run |
| Global shortcuts (Ctrl mapping, conflicts with IME / Windows shortcuts) | ✅ | ⬜ manual check needed; Ctrl+\\ is layout-dependent on non-US keyboards |
| Overlay always-on-top over full-screen apps; multiple displays with mixed DPI | ✅ single + external display | ⬜ |
| OS screen capture with a real permission grant | ⬜ the build machine denies Screen Recording to the runner; region/import/OCR paths verified | ⬜ |
| System-audio loopback with a real source | ⬜ | ⬜ |
| Installer (DMG / NSIS), code signing, notarization, auto-update | ⬜ no certificates; unsigned builds trigger Gatekeeper / SmartScreen | ⬜ |
| Real Anthropic / OpenAI / Gemini / Deepgram calls | ⬜ no keys on the build machine; `npm run test:live` is ready | — |

Other limitations:
- Retrieval is keyword (BM25) based unless you set up a local embedding model (see `docs/LOCAL_AI.md`). Paraphrased questions can miss relevant passages.
- Local models (Ollama) are supported but not yet verified against a real runtime; see `docs/LOCAL_AI.md`.
- Quality metrics and proposals are local to one install. With little use they are preliminary; they are not a measure of answer quality — the Evaluation Lab is.
- Oversized documents are reduced to their opening plus the passages matching the question. A passage that shares no words with the question can still be omitted.
- Response-planner intent rules score 78% / 42% (relations / categories) on a held-out set. A miss falls back to a general strategy; it does not refuse.
- Memory use is about 670 MB across Electron processes on macOS.

**External services:** your AI provider (Anthropic, OpenAI, Google or a compatible endpoint) and, optionally, Deepgram. No Lumen backend, account or telemetry exists; beta reports are files you send yourself.
