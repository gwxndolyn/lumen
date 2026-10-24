# Lumen beta programme: feedback, triage and evidence-driven improvement

This is the operating manual for the controlled beta. It describes what the code in this repository actually does. Where something needs infrastructure or a person that this repository can't provide, it says so.

## 1. Architecture decision: local-only reports, sent by the tester

Lumen has no backend, accounts or telemetry (`docs/COMMERCIAL.md`), and its privacy promise is that nothing leaves the computer except what the user sends to their AI provider. For a beta of a few dozen invited testers, a feedback server would add a hosting bill, an abuse surface, a data store of other people's text to protect, and a new privacy story — before there is evidence it is needed.

So the first beta uses **files**:

```
Tester's Lumen                          Lumen team (access-controlled storage, outside this repo)
──────────────                          ───────────────────────────────────────────────────────
Send feedback / "Report" on an answer
  → draft (local DB, survives restart)
  → Preview (exact bytes)
  → Save report file…  ── tester emails / uploads it ──▶  npm run triage -- import <files>
                                                          → issues.json (triage, audit log)
                                                          → regression-cases.json (in repo, reviewed)
                                                          → npm run release:gate
```

Nothing is uploaded automatically, and the UI says so in the header, after saving ("It has **not** been sent"), and in Privacy. The `report_exported` usage event records that a file was saved, not that it arrived.

**When to add a server.** Add one when manual forwarding loses reports or delays triage. The number of reports in `triage summary` will show whether that is happening. Requirements are in §9; the report schema and the importer's validation are already the server's input contract.

## 2. What a tester can submit

Main window → **Send feedback** (sidebar, command palette "Send feedback…"), or **Report** under any answer (links the report to that answer).

| Field | Required | Notes |
|---|---|---|
| Category | yes | privacy · crash · something doesn't work · incorrect/low-quality answer · capture/transcription/context · slow · confusing · missing functionality · feature request · overall usefulness (1–5) · other |
| Description | yes | ≤ 4,000 chars |
| Impact | no | blocks my work / major / minor |
| Area | no | assistant, screen capture, transcription, … |
| Steps to reproduce | no | ≤ 2,000 chars |
| Diagnostics | opt-in | §4 |
| Usage summary | opt-in | 30-day counts and setup milestones; no content |
| Question/answer excerpt | opt-in, only for a linked answer | pre-filled, **editable**, ≤ 2,000 chars each; the preview warns if it's unedited |

Workflow: **Preview** (required; "Save report file…" stays disabled until a preview exists) → **Save report file…** → the file is written with owner-only permissions → the status changes to *Saved to file*. If the write fails, the status becomes *Save failed* with the reason, and **Retry** is offered. Editing a saved report makes it a draft again and requires a new preview. Reports can be continued, discarded, or removed from the list. Drafts are capped at 50 and follow the conversation retention setting. *Delete everything* removes them.

## 3. Report schema and data minimisation

`src/core/beta/report.ts` (`lumen-beta-report`, `schemaVersion: 1`). Fields: id (random UUID), createdAt, category, description, severity, area, steps, usefulness, `app` {version, platform, arch, osRelease, electron, packaged}, `interaction` (if linked), `attachments` {diagnostics, usage, excerpt}.

**Always excluded:**
- API keys and tokens
- screenshots, audio, transcripts
- documents, notes, memories
- full conversations
- workspace files
- user name, computer name and home folder
- any install, device or account identifier

The linked `interaction` is metadata only: task type, provider/model, route, context source *kinds*, timings, answer-check names, stop reason and prompt hash. Its `messageId` is a random local id that means nothing outside the tester's install.

There is deliberately **no persistent install id**. Duplicates are found by content (§5), not by fingerprinting the reporter.

**Scrubbing.** All free text is scrubbed on build, and again on import:
- credentials: `src/core/credentials.ts`, the same list the log uses
- cards, passwords, SSNs, JWTs and private keys: `context/sensitivity.ts`
- the home folder, replaced with `~`
- control and bidi-override characters, which could fake output in a reviewer's terminal

**Validation on import.**
- Rejected outright: over 256 KB (checked before parsing), not JSON, wrong `kind`, a schema newer than the tool, any field outside its type or limit.
- Diagnostics must be a bounded tree of scalars (strings ≤ 500 chars, arrays ≤ 400).
- Only the re-validated, re-scrubbed object is stored, never the original bytes.
- Older schema versions go through `upgrade()`, which is append-only.

## 4. Diagnostics export

Two outputs share one builder (`supportSummary()` in `electron/main.ts`):

- **Support file**: *Diagnostics → Preview support file / Save support file*.
- **Diagnostics attachment** on a report.

| Included | Excluded |
|---|---|
| App, Electron, Chrome and Node versions; OS type, release and arch; RAM | API keys (only "configured: yes/no"); auth headers |
| Settings that matter for support: provider kind, model, transcription kind, consent flags, redaction on/off, usage events on/off, log level | Data, DB and log paths (replaced by `[data folder]`); home folder (`~`) |
| Provider health, permission state, capture capabilities, shortcut registration | Prompts, answers, transcripts, screen text, documents, notes |
| Pipeline state: live-screen lifecycle, OCR queue, transcription status/buffer/drops/reconnects, context counts, in-flight requests | Stack traces and arbitrary log fields (reports keep only a safe field list, one line each) |
| Latency percentiles, retry counts, failures by error code, answer-check counts, last 20 request rows (timings and tokens) | |
| Operational log events from the **last 24 hours** | Anything older |

Limits: the log is read from its last 2 MB. Support files are capped at 512 KB and reports at 256 KB; the oldest log events are dropped first, and the report says when that happened. If a build fails, the error is shown before the save dialog opens.

Tests (`src/test/betaProgramme.test.ts`, `src/test/supportBundle.test.ts`):
- seven key shapes are checked against the log, support file and reports
- home-folder replacement
- time window
- size caps
- stack traces excluded
- hand-edited files re-scrubbed
- every key shape checked on the log file on disk

Mutation checks: reverting the logger or provider-redaction fix fails 2 tests each.

## 5. Triage (reviewer side)

`scripts/triage.mjs` and `src/core/beta/triage.ts`. Set `LUMEN_TRIAGE_DIR` to a workspace **outside this repository**; the tool refuses a path inside it, because the workspace holds user text. Keep it in access-controlled storage (an encrypted shared drive or a private bucket), readable only by the beta team.

| Command | Purpose |
|---|---|
| `import <files or folder> [--attach BETA-n]` | Validate and import. Detects re-imports (same id) and identical content (different id) instead of double counting. |
| `list [--class] [--status] [--all]` | Open issues in priority order |
| `show BETA-n` | Issue, its sanitised reports, history. Excerpts are labelled private. |
| `set BETA-n field=value` | class, status, title, userImpact, reproSteps, suspectedRootCause, proposedFix, aiRootCause |
| `repro BETA-n reproduced\|not_reproduced --notes --version` | Reproduction result; *reproduced* confirms the issue |
| `dup` / `link` / `similar` | Duplicates (moves their reports to the target), related issues, suggestions |
| `fix BETA-n --commit <sha> --test <file\|case>` | Needs ≥ 1 regression test |
| `verify BETA-n passed\|failed --version` | *passed* needs a fix and a test; *failed* reopens it as *unresolved* |
| `propose-case` / `approve-case` | §6 |
| `summary` / `export` / `blockers` | Observed counts. `export` has no report text. `blockers` exits 1 on open security/privacy or data-loss issues. |

**Priority.** Issues are sorted by class:
1. security/privacy
2. data loss/crash
3. broken core
4. AI behaviour
5. performance
6. usability
7. features/cosmetic

Within a class, reproduced issues come first, then those with more observed reports. A reviewer changes an issue's class when the evidence shows a different risk; the change is logged.

**Evidence labels.**
- *frequency* is the count of distinct imported reports, never an estimate.
- *observed* means at least one report.
- *reproduced* means a reproduction was recorded.
- *hypothesis* means no report (for example, an issue found by an engineer).

`summary` says when fewer than 20 reports exist that the category mix is not a trend.

**Integrity.** Every change is appended to the audit log. Writes go to a temp file, then a rename. A workspace file with a newer schema is refused. Status shortcuts are refused: `verified` only via `verify`, `fixed` only with a recorded fix, `duplicate` only via `dup`.

## 6. From feedback to regression coverage

1. **Decide the root cause first.** For AI behaviour, set `aiRootCause`: context selection, prompt construction, provider behaviour, model limitation, rendering, user expectation, or unknown. Only *prompt construction* is fixed by editing prompts. Context selection is fixed in the ranker or engine; rendering in the UI; a model limitation by routing or by documenting it.
2. **Write the case.** Use a synthetic case wherever it reproduces the problem. If a real example is necessary, rewrite it until it carries no names, code or data from the report, set `--origin sanitized_user_example --sanitization "<what was replaced, by whom>"`, and keep the original only in the triage workspace.
3. `npm run triage -- propose-case BETA-n case.json --by <you>` appends to `src/core/eval/regression-cases.json` as **proposed**. Proposed cases are **not run**. The case is refused if:
   - its id isn't `reg-…`
   - the issue id is invalid
   - an assertion type is unsupported or a regex is invalid
   - fixtures exceed the size limits
   - any string still looks like a credential, card number, password or other sensitive value
   - a user-derived case has no sanitisation note

   Secret-shaped test inputs must contain `FAKE` or `EXAMPLE`.
4. **Another reviewer** runs `approve-case <id> --by <name>`. The proposer can't approve their own case; that needs an explicit option in code. Approval pins a hash of the definition, so editing an approved case makes it *stale* and it isn't run until re-approved. `npm run eval` prints approved, proposed and stale counts.
5. `npm run eval` runs the shipped benchmark plus the approved cases (`--collection benchmark|regressions|all`). The release gate's **regressions** check runs the approved collection; failures block. `--baseline` comparisons still mark changed or dropped cases inconclusive.
6. Record `fix` with the commit and the case id, then `verify` against the build that contains it.

Feedback never changes prompts, routing, settings or behaviour automatically. In-app per-answer ratings still feed the local Quality screen, proposals and "My test cases" (Prompt 10). Those stay on the tester's own machine and are separate from the trusted collection.

## 7. Usage events and beta metrics

**Is analytics justified?** Not remote analytics, not for this beta. The local, content-free events from Prompt 10 are enough to answer "did setup work, and are answers completing?" per tester. A tester who agrees can share them by ticking **Usage summary** on a report. No events are transmitted, and there is no fallback that transmits them.

**Consent model.**
- *Privacy → Usage events on this computer → Record usage events* is **on by default**. Recording is local only: nothing is sent, and the switch explains exactly what is kept.
- Turning it off stops all new recording immediately: request events, milestones, and the event for each rating (the rating the user explicitly saves is still kept). Nothing else changes. **Delete usage events** erases them.
- Retention follows conversation retention (90 days by default; 0 = keep).
- Sharing is a second, explicit choice per report, shown in the preview.

**Events.**
- Requests (from Prompt 10): `request_completed`, `request_failed`, `request_cancelled`, `retry`, `verification_flagged`, `context_selected`, `feedback`.
- Milestones (new): `app_started`, `onboarding_completed`, `provider_test` (code = ok or error code), `context_activated` (code = screen, microphone or systemAudio), `session_restored` (once per launch), `report_exported`, `diagnostics_exported`, `update_check` (code = up_to_date, available or error; not recorded when the build has no feed).

Milestone codes are restricted to `[a-z0-9_.:-]` and 40 characters. Unknown types are refused.

**Metric definitions** (`QualityService.activation()`; also in the Usage summary). Each is null until its inputs exist, and none is aggregated across testers by code; the team aggregates them by hand from shared reports.

| Metric | Definition | Data | Limitations |
|---|---|---|---|
| Onboarding completed | `onboarding_completed` recorded | milestone | Installs that onboarded before this build never record it |
| Time to first answer | first `app_started` → first `request_completed` that is neither mock nor cached | milestones + request events | Only from when recording started; null for older installs |
| Provider setup failure rate | `provider_test` with code ≠ ok ÷ all `provider_test` | milestone | Repeated tests by one person weigh more than one person |
| Technical request success | completed ÷ (completed + failed); cancellations excluded | request events | "Completed" means a response was produced, **not** that it was useful |
| User-perceived usefulness | answers rated Helpful vs. any other rating; report category *usefulness* (1–5) | explicit ratings | Self-selected and small; never a satisfaction score |
| Repeat usage | distinct calendar days with a completed answer | request events | Local to one install; testers share it only by choice |
| Issue recurrence after a fix | issues whose `verify` failed, or new reports attached to a verified issue | triage workspace | Needs reports on the fixed version |
| Crash-free sessions | **not measured**: renderer crashes are logged, but main-process crashes leave no reliable marker and there is no crash reporter | — | — |

**Minimum data before reading anything:**
- rates need ≥ 30 underlying events per install (the Quality screen already marks smaller samples *preliminary*);
- cross-tester statements need reports from ≥ 10 testers;
- trends need ≥ 20 reports.

No thresholds for "success" are set yet: pick them after the first two weeks of real data, not before.

**Real data today: none.** There are no beta testers yet. Every number this repository has produced comes from synthetic tests.

## 8. Feature flags and experiments

Not added. There are no staged rollouts (builds go to a hand-picked group), no remote configuration (it would be a new trust channel that could change behaviour without review), and no experiment with a defined hypothesis. Experimental behaviour stays behind existing explicit settings (economy routing, response cache, hybrid mode: all off by default) and Evaluation Lab experiments, which are offline and need a person to start them. Revisit this when a change needs a cohort comparison that the Evaluation Lab can't provide; define the hypothesis, metric, guardrails and rollback criteria first.

## 9. If a feedback server is added later

Implement:
- HTTPS only, accepting the existing `reportSchema` (reuse `parseReport`: size cap before parsing, schema check, re-scrubbing);
- per-install upload tokens from the invitation, not a shared secret in the app; no admin credentials in the client;
- rate limiting per token and IP, with server-side size limits;
- append-only storage readable only by the beta team (separate read and write roles);
- retention: delete reports 180 days after the beta ends, and on request by report id;
- tests for unauthenticated, oversized, malformed and replayed submissions.

Keep the file path working, so the app never needs the server.

## 10. Release workflow

```bash
npm run release:gate -- --packaged --baseline release-benchmark.json   # every check; writes release-report.json (now with the commit)
npm run package:mac      # or package:win on Windows
npm run release:artifacts
```

`release:gate` adds two checks:
- **regressions**: the approved beta cases; critical.
- **beta-blockers**: `triage blockers`; critical. It is skipped, and listed as a limitation, when `LUMEN_TRIAGE_DIR` isn't set on the release machine.

`release:artifacts` (`scripts/release-artifacts.mjs`) never signs, uploads or publishes. It:
1. requires `release-report.json` for this version **and commit** with a READY verdict, a passed packaged-app smoke, and a clean tree;
2. inspects every packaged `app.asar`:
   - required entry points are present;
   - no source maps, TypeScript, `.env`, repo `src/`, `scripts/` or `docs/`, dev dependencies, test folders, evaluation or release data, or user data;
   - every text file is scanned for real-looking keys;
3. writes `release/SHA256SUMS` for the installers of this version and flags artifacts from other versions;
4. reads signing status from the artifacts (`codesign` / `spctl` on macOS), never assumes it;
5. writes `release/release-manifest.json` (version, commit, gate checks, artifacts, package inspection, signing, `publishable`, blockers, what wasn't checked) and `release/RELEASE_NOTES.md` (CHANGELOG *Unreleased* + downloads with checksums + signing + known limitations + how to send feedback).

It exits 1 on any gate or package problem. Unsigned builds are reported NOT PUBLISHABLE (fine for hand distribution to invited testers).

| | macOS (this machine) | Windows |
|---|---|---|
| Gate, package, artifacts script | ✅ runs | runs, but must be executed on Windows (signing check reports *not checked* elsewhere) |
| Signing, notarization | ⬜ needs Apple Developer ID + notary credentials | ⬜ needs an Authenticode certificate |
| Automatic update | not implemented: manual feed check only (`docs/COMMERCIAL.md`) | same |
| Rollback | reinstall the previous installer; after a schema migration the older build refuses the newer DB, so restore `lumen.db.backup-v<N>` | same |

## 11. For testers: where to send reports

Send report files and support files to the beta contact named in your invitation. Do not post them in public issue trackers: a report can contain the excerpt you chose to include.

## 12. The improvement loop, end to end

**collect** (report file) → **sanitise** (build + import scrubbing; excerpt edited by the tester) → **triage** (`import`, class, priority) → **reproduce** (`repro`, regression case) → **fix** (focused change + test) → **regression coverage** (`propose-case` → `approve-case`) → **evaluate** (`npm run eval`, gate) → **release** (`release:artifacts`) → **verify** (`verify` on the shipped version; a failure reopens).

AI assistants (including Claude Code) may analyse reports and propose patches and cases. Every change goes through the same tests and gate, and a person reviews and merges it. Nothing in this repository deploys or merges on its own.

The loop was exercised end-to-end on synthetic data in this branch for **BETA-001** ("OpenAI project key sent unmasked"); see the worked example in `docs/autonomous-improvement/CURRENT_STATE.md`.
