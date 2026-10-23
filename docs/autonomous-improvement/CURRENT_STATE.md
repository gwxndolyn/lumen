# Lumen — current improvement state

Last updated: 2026-10-23 · Branch: `improve/autonomous-loop` (from `master` @ `871ca43`)

## Latest: Prompt 7 committed (2026-10-23)

Prompt 7 (model intelligence engine) is committed on this branch: answer verification (`intelligence/verify.ts`), economy routing (`intelligence/router.ts`, off by default, same provider only), project memory (`intelligence/memory.ts`, Memory screen, migration 6) and the "context used" list. The support file (`src/core/supportBundle.ts`) is kept, now covered by `src/test/supportBundle.test.ts` (mutation-checked: removing scrubbing fails 2 tests).

Verified on resume: `npm run check` 346 passed / 4 skipped; `format`, `audit:prod`, `smoke` pass.

Note: vitest and the smoke run need to write to `node_modules/.vite-temp`; under the Claude Code sandbox they must run unsandboxed.

## Prompt 8: Evaluation Lab (2026-10-23, committed)

- `src/core/eval/`: benchmark v1.0.0 (64 synthetic cases, 12 categories), runner on the real AppCore pipeline (isolated in-memory store), scripted provider for deterministic mode, scoring across 8 separate metrics, JSON run history (`userData/evaluations`), baseline comparison, experiments (verification, context budget, prompt version).
- UI: Evaluation Lab screen (Run / Results / Compare / Cases). Live runs need a confirmation checkbox and show a worst-case cost estimate.
- CLI: `npm run eval` (deterministic; exit 1 on failures), `--baseline run.json` (exit 1 on regressions), `npm run eval:live -- --yes` (needs `ANTHROPIC_API_KEY`). CI runs the deterministic benchmark.
- The benchmark found 2 real bugs, now fixed in `chatService.ts`: retrieved conversation history and memories with no keyword overlap were dropped by the ranker's relevance cut.
- Deterministic: 64/64 pass. Ablations detected by the gate: verification off → 7 regressions; minimal prompt → 1 (inj-005). An 8k context budget → 0 (no case is sensitive to it yet).
- **Not run: live mode against a real provider** (no API key here). Answer-quality checks are regex/structure only; no LLM judge.

**Next:** run `npm run eval:live -- --yes --max-cost 1` with a key, then set it as the baseline (LUM-011). Add a budget-sensitive case.

## Prompt 9: hybrid local/cloud inference (2026-10-23, committed)

- `providers/ollama.ts`: native Ollama API adapter (loopback only; discovery, capabilities, context length, streaming, cancel, timeouts, embeddings). Never downloads models.
- `inference/hybrid.ts`: routing (manual / local first / cloud first) + privacy restriction + policy-only fallback. `inference/usage.ts`: ledger with reported/estimated and cost basis, per-session cost/request limits, concurrency, worst-case pre-check. `inference/cache.ts`: in-memory response cache (off by default). `inference/embeddings.ts`: optional local semantic search, one model per index.
- Migration 7. Timeouts are no longer retried by default (behaviour change; test updated). Settings UI in AI provider. Eval runs can target the local model and record hardware/memory. Docs: `docs/LOCAL_AI.md`.
- **Not verified against a real Ollama** (not installed here): all local tests use a stand-in speaking the documented wire format.

## Prompt 10: quality loop (2026-10-23, committed)

- Migration 8: `feedback`, `quality_events` (content-free), `user_eval_cases`. `quality/service.ts` (feedback, events, metrics, feedback → reviewed test case), `quality/proposals.ts` (evidence-gated proposals; ≥5 to raise, <30 preliminary).
- Feedback button on answers; Quality screen (overview, feedback, proposals, my cases); "My cases" collection in the Evaluation Lab.
- Comparisons now warn when case definitions changed or baseline cases were dropped (edited cases are inconclusive, never passes).
- `npm run release:gate`: runs every check, writes `release-report.json`; NOT READY if a critical check fails or didn't run; READY FOR BETA without live-provider tests; signing never checked.
- Gate result on this machine: READY FOR BETA (445 tests, 64/64 benchmark, 0 regressions vs baseline, smoke pass; live skipped).
- No AI coding workflow exists in Lumen, so §7 is covered by this repo's process (branch, tests, gate, user approval before merge), not new code.

## Prompt 11: commercial layer (2026-10-23, committed)

- Model: Free (full assistant, BYO key or local) + Pro via offline Ed25519 license key; no accounts, no in-app payment (store page opens in the browser). `core/commerce/{license,entitlements,updates,config}.ts`, `scripts/issue-license.mjs`, `docs/COMMERCIAL.md`.
- Entitlements enforced in core (settings, routing, memory, embeddings, live eval). Expiry → 7-day grace → Free; data never locked.
- Onboarding: 6 resumable steps (persisted `onboardingStep`), local-model path, real first question. New Plan & updates and Help screens; developer screens grouped under "Developer".
- Manual HTTPS update check; no downloads. Config is empty in this repo → open build, no purchase or feed URL.
- Launch blockers (vendor credentials): signing/notarization, license key pair + store + webhook, update feed hosting, live-provider verification, Windows hand testing, legal pages.

## Prompt 12: desktop UX (2026-10-23, committed)

- Command palette (⌘K/Ctrl+K, state-aware commands, fuzzy, keyboard, focus trap/return, no double-fire), verified with real key events in smoke.
- Main-window geometry persisted (settings.mainWindow); narrow layout collapses sidebar; context chips show source/time; interrupted recordings recovered at startup.
- Tokens extended (type scale, elevation, z-index, timing). Shortcut registry already met requirements — unchanged.
- See `docs/DESKTOP_UX.md` for verified vs unverified (Windows, screen readers, real restart of geometry).

**Next:** with an API key, run live evaluations (cloud and a local Ollama model) and record a baseline; then LUM-011.

## How to resume (any session, no chat history needed)

1. `cd ~/Documents/lumen-assistant && git status && git log --oneline -8` — confirm you are on the branch above and the tree is clean.
2. Re-establish the baseline (all must pass before changing anything):
   ```
   npm run check          # typecheck + lint + unit/integration tests
   npm run audit:prod     # advisories in shipped code (exit 1 = real problem)
   npm run format         # prettier on files changed vs master
   npm run smoke          # real Electron app vs local Anthropic/Deepgram stand-ins
   ```
   If a result differs from "Verification" below, that difference is the first task.
3. Open `backlog.json`. Pick the highest-ranked item with status `open` (critical defects, then production blockers, then by impact × confidence ÷ effort). Skip `blocked` items unless the blocker is resolved.
4. One item per cycle: inspect → baseline → smallest change → verify → update `backlog.json` and this file → commit on the branch.
5. Do not merge to `master` without the user reviewing the branch.

Sessions are started by a person running Claude Code in this folder. Nothing in this repository launches AI sessions on its own, by design.

## Product state

Lumen is an Electron + React desktop AI assistant (macOS and Windows; Linux builds untested). It has:
- a floating panel and a main window;
- Anthropic, OpenAI, Gemini and OpenAI-compatible providers;
- on-device OCR and Deepgram live transcription;
- sessions, a knowledge base and a rule-based response planner (`src/core/intelligence`).

## Verification (2026-10-22, this branch)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass (warnings denied) |
| `npm test` | 429 passed, 4 skipped (live-provider tests; need API keys) — 2026-10-23 |
| `npm run audit:prod` | pass: 3 advisories, all in modules excluded from the asar |
| `npm run format` | pass (changed files) |
| `npm run smoke` | pass on this branch (after the error-boundary change) |
| GitHub Actions CI | **not run**: no runner from this environment |
| Real providers / Windows runtime | **blocked**: keys and hardware |

Intent accuracy, from `src/test/intentEval.test.ts` (synthetic labels):

| Set | Relations | Ambiguity | Categories |
|---|---|---|---|
| Tuned set (incl. former holdout #1) | 96% | 100% | 99% |
| Held-out set #2 (written before tuning) | 78% | 100% | 42% |

The held-out set is the honest number. Tuning the rules on known misses did not move held-out #2 at all, so keyword rules have plateaued. Misses fall back to "general", which now asks the model to choose the task's structure itself.

## Cycles completed

| # | Item | Outcome |
|---|---|---|
| 1 | LUM-001 renderer error boundary | done; the test caught host elements being reported as components |
| 2 | LUM-004 Technical screen silent failure | done |
| 3 | LUM-003 working `format` scripts | done; changed-files mode to avoid touching 70 legacy files |
| 4 | LUM-005 audit advisories | done via a shipped-code audit gate; negative test confirms it fails when an exclusion is removed |
| 5 | LUM-002 CI workflow | written and YAML-validated; **unverified** until first push |
| 6 | LUM-006 intent evaluation | done; baseline, then targeted fixes, then a held-out measurement |
| 8 | LUM-012 symptom words → debugging | partial; holdout #3 (written first) categories 11/18 → 13/18, wrong templates 5 → 3; "slow" rejected (broke a frontend case) |
| 7 | LUM-009 category recall | partial; rules stopped generalising (held-out #2: 42% before and after); the general fallback was made safer. Next step needs a key (LUM-011) |

## Blockers (need the user)

- **API keys** for `npm run test:live` (Anthropic, OpenAI, Gemini, Deepgram).
- **Windows machine or CI runner.** Pushing the branch to GitHub runs `windows-latest`.
- **Code-signing certificates** (Apple Developer ID; Windows Authenticode).
- **Disk space.** About 8 GB free (96% full). `release/` holds old builds and is safe to clear.

## Next recommended action

- **With an API key:** LUM-011. Measure whether classification misses actually produce worse answers before adding a model call.
- **Without one:** LUM-012 (small), then LUM-010 (a one-off formatting commit; ask before merging).

## Lessons

- Every gate needs a negative test. The first audit-gate version passed even with the exclusions removed: the packaged asar was still present, and its check also matched a commented line.
- Measure on data you didn't tune on. Tuned-set accuracy went to 100%, while the held-out set shows 74% for categories.
- Keyword rules only fix the phrasing they were written for. Held-out #2 stayed at 42% after rule changes. Stop tuning rules; measure the impact instead (LUM-011).
