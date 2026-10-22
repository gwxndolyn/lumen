# Lumen — current improvement state

Last updated: 2026-10-22 · Branch: `improve/autonomous-loop` (from `master` @ `871ca43`)

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
| `npm test` | 280 passed, 4 skipped (live-provider tests; need API keys) |
| `npm run audit:prod` | pass: 3 advisories, all in modules excluded from the asar |
| `npm run format` | pass (changed files) |
| `npm run smoke` | pass on this branch (after the error-boundary change) |
| GitHub Actions CI | **not run**: no runner from this environment |
| Real providers / Windows runtime | **blocked**: keys and hardware |

Intent accuracy, from `src/test/intentEval.test.ts` (synthetic labels):

| Set | Relations | Ambiguity | Categories |
|---|---|---|---|
| Tuned set | 100% | 100% | 100% |
| Held-out set | 89% | 100% | 74% |

The held-out set is the honest number.

## Cycles completed

| # | Item | Outcome |
|---|---|---|
| 1 | LUM-001 renderer error boundary | done; the test caught host elements being reported as components |
| 2 | LUM-004 Technical screen silent failure | done |
| 3 | LUM-003 working `format` scripts | done; changed-files mode to avoid touching 70 legacy files |
| 4 | LUM-005 audit advisories | done via a shipped-code audit gate; negative test confirms it fails when an exclusion is removed |
| 5 | LUM-002 CI workflow | written and YAML-validated; **unverified** until first push |
| 6 | LUM-006 intent evaluation | done; baseline, then targeted fixes, then a held-out measurement |

## Blockers (need the user)

- **API keys** for `npm run test:live` (Anthropic, OpenAI, Gemini, Deepgram).
- **Windows machine or CI runner.** Pushing the branch to GitHub runs `windows-latest`.
- **Code-signing certificates** (Apple Developer ID; Windows Authenticode).
- **Disk space.** About 8 GB free (96% full). `release/` holds old builds and is safe to clear.

## Next recommended action

LUM-009 (category recall on unseen phrasing). First write a new held-out set, then fold the current one into the tuned set, then tune. After that, LUM-010 (a one-off formatting commit).

## Lessons

- Every gate needs a negative test. The first audit-gate version passed even with the exclusions removed: the packaged asar was still present, and its check also matched a commented line.
- Measure on data you didn't tune on. Tuned-set accuracy went to 100%, while the held-out set shows 74% for categories.
