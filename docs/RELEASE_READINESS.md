# Release readiness (2026-10-23, Lumen 0.3.0, commit after 6b2c0f6)

**Classification: ready for a controlled beta on macOS (Apple Silicon), with users who bring
their own API key. Not ready for public release.** Evidence below; nothing here was verified
against a real AI provider, real capture hardware permissions, or Windows.

## How to validate a release
```bash
npm run release:gate -- --baseline <last release-benchmark.json> --packaged
npx electron-builder --mac dmg --arm64 --publish never      # installer (unsigned without a Developer ID)
```
`release:gate` runs, and records in `release-report.json`: type check, lint, unit/integration
tests, secret scan, shipped-dependency audit, build, deterministic benchmark vs baseline, Electron
smoke (real UI), restart persistence (two real launches), upgrade from an older schema, and with
`--packaged` the packaged-app smoke. A critical check that fails **or doesn't run** = NOT READY.
Live provider tests run only with `ANTHROPIC_API_KEY`; without them the best verdict is
"READY FOR BETA".

Individual journeys: `npm run smoke`, `bash scripts/smoke-restart.sh [binary]`,
`bash scripts/smoke-upgrade.sh [old-ref] [binary]`, `npm run smoke:packaged`.

## A. Journeys

| Journey | Result | How |
|---|---|---|
| Fresh launch → onboarding shown | ✅ pass | smoke `ONB_credentials.onboardingFresh` |
| Wrong API key → "rejected" (not "connected") | ✅ pass | smoke, real SDK → local stand-in returning 401 |
| Quota exhausted → rate-limited message | ✅ pass | smoke, 429 |
| Unknown model / network down / no key | ✅ pass | unit (harness) — real SDK over fake HTTP |
| Key never reaches the renderer or localStorage; stored encrypted (OS keychain), file 0600 | ✅ pass | smoke `ONB_keyNotExposed`; inspected profile |
| Onboarding resumes at the saved step after reload | ✅ pass | smoke `ONB_resume` |
| Ask → stream → render; stop mid-stream | ✅ pass | smoke A |
| Screen capture → on-device OCR → answer cites it | ✅ pass | smoke B (image import path; real Tesseract) |
| Transcript → question about it | ✅ pass | smoke C (real WebSocket client → Deepgram-wire stand-in; real mic device) |
| Session isolation in the UI | ✅ pass | smoke E |
| Revoke screen permission → capture blocked, context cleared | ✅ pass | smoke F |
| Network drop mid-answer → partial kept, error, no spinner; Try again sends exactly once | ✅ pass | smoke `I_networkDrop`, `I_retryAfterDrop` |
| Code block renders; Copy puts exact code on the system clipboard | ✅ pass | smoke `I_codeCopy` |
| Command palette by keyboard; narrow layout | ✅ pass | smoke `CP_palette`, `UX_narrowLayout` |
| Delete session removes conversations and search index | ✅ pass | smoke H |
| Quit normally → relaunch: session, open conversation, note, settings restored; DB closed cleanly | ✅ pass | `smoke-restart.sh` — dev build, packaged app |
| Upgrade a profile written by an older build (schema 6 → 8) | ✅ pass | `smoke-upgrade.sh` — dev build, packaged app; backup kept |
| Corrupt database on launch | ✅ pass | quarantined to `lumen.db.corrupt-…`, fresh DB, dialog — run by hand once |
| Disk full while saving an answer | ✅ pass | unit probe: honest "couldn't save" error, request cleared |
| Packaged app smoke | ✅ pass | `smoke:packaged` |
| DMG installer builds, mounts, installs by copy, installed app passes smoke | ✅ pass (unsigned) | built `Lumen-0.3.0-arm64.dmg` |
| Real Anthropic / OpenAI / Gemini / Deepgram / Ollama | ⬜ unverified | no credentials / runtime |
| Real Screen Recording grant, display hotplug, mic unplug, sleep/wake, Wi-Fi loss | ⬜ unverified | needs a person (docs/CAPTURE_RELIABILITY.md) |
| Windows | ⬜ unverified | |

## B. Defects found and fixed in this round
See `docs/autonomous-improvement/backlog.json` LUM-013…015.
1. **Provider health after replacing a rejected key** stayed "degraded/down" until a manual
   test (root cause: key changes only re-applied settings). Fixed: `AppCore.credentialsChanged()`.
2. **Database readable by other local accounts** (`lumen.db` 0644). Fixed: db/WAL/SHM 0600, data
   folder 0700 on macOS/Linux; mutation-checked test.
3. **No automated check for restart, upgrade, packaged app** — added scripts and gate checks.
4. **Flaky gate**: the whole-benchmark test (~0.4 s) exceeded vitest's 5 s default while the gate
   was packaging the app in parallel. Explicit 30 s timeout; root cause is load, not the code.

## F. Security and privacy — verified controls
- Renderer: `contextIsolation`, `sandbox`, no Node, navigation and new windows blocked, CSP;
  model output rendered as text (no `innerHTML`; covered by markdown tests).
- Every file path comes from an OS dialog; external links HTTPS only.
- Keys: OS keychain encryption (`safeStorage`), `secrets.json` 0600, never sent to the renderer,
  redacted in logs and support files.
- Untrusted context is fenced, injection-shaped text is flagged, and no content can trigger an action
  (Lumen has no tools / command execution). Benchmark `inj-*` cases.
- Privacy restriction and provider routing never fall back to another cloud provider silently.

**Remaining risks:** unsigned builds (Gatekeeper/SmartScreen warnings, no auto-update); prompt
injection is mitigated, not prevented (a model may still follow embedded text in its answer);
Windows file ACLs not checked; no third-party security review.

## I. Blockers for public release
| Blocker | Needed |
|---|---|
| Live provider verification (LUM-016) | API keys; run `npm run test:live` and a live evaluation |
| Capture hardware validation (LUM-017) | A person on macOS and Windows; steps in docs/CAPTURE_RELIABILITY.md |
| Signing / notarization | Apple Developer ID, Windows code-signing certificate |
| Windows | Hand testing on Windows 10/11 |
| Commercial setup | License key pair, store, update feed (docs/COMMERCIAL.md) |

## J. Next priority
Run the live provider tests and a live evaluation with a real Anthropic key — every AI answer
path has been verified only against wire-compatible stand-ins.
