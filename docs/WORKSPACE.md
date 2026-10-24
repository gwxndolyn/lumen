# Project workspace

*Projects* in the main window: local project folders, durable tasks with plans, an approval-gated agent, a traced change ledger, and verification history. Code: `src/core/workspace/`. Security model: `SECURITY.md` → *Project workspace and agent*.

## What exists

| Area | What it does | Where |
|---|---|---|
| Projects | Add a folder (native picker), open, rename, relocate a moved folder, remove the reference (files are untouched). Status: available / missing / inaccessible. One root per project; nested projects and the home/disk root are refused. | `service.ts`, `boundary.ts` |
| Persistence | Migration 10 in the existing SQLite store: `projects`, `tasks`, `task_steps`, `task_events` (append-only evidence), `approvals`, `file_changes`, `verifications`. All rows keyed by project; removing a project cascades to its records. | `storage/db.ts`, `workspace/store.ts` |
| Tasks | Statuses: backlog, ready, running, waiting_approval, paused, verifying, blocked, failed, cancelled, completed. Every transition is validated (`tasks.ts`). *completed* is reachable only from *verifying*, and only when no step is open, no approval is pending, and (unless switched off per task) the latest verification passed **and is still current**. | `tasks.ts` |
| Plans | Ordered steps with dependencies (unknown deps and cycles rejected; reordering can't move a step before its dependency; a step can't start before its dependencies are done). | `tasks.ts` |
| Agent | The model replies with one JSON action per turn (schema-validated). Lumen performs reads/searches/plan updates; proposes edits as approval requests showing the exact diff; runs only pre-approved commands, otherwise asks; `finish` triggers the evidence check. Limits: 25 actions per run, bounded reads/observations. Provider failures and usage limits block the task with the reason. | `agent.ts`, `service.ts` |
| Changes | Every agent write is recorded with task, run, kind, before/after hashes and text. Diff view; revert only if the file still matches the agent's version (else *conflict*, nothing overwritten). Edits are also refused if the file changed between proposal and approval. | `service.ts`, `diff.ts` |
| Verification | Commands from project settings (argv, no shell), run in the project root with a timeout, cancellation, output cap and credential-free environment. Statuses: running, passed, failed, timed out, cancelled, could not run, interrupted. Each run stores the project fingerprint; a pass becomes *out of date* as soon as files change. | `runner.ts`, `service.ts` |
| Index & search | Incremental (unchanged size+mtime keeps the old fingerprint), bounded (20k files, 1 MB/file, 15 s), honours `.gitignore` (practical subset) and project exclusions, skips symlinks, binaries' contents and protected files. Search: filenames, definitions, text. | `indexer.ts` |
| Git | Read-only branch, ahead/behind, status (marking files the agent changed vs. the rest), recent commits. Non-repos and missing git handled. | `git.ts` |
| Recovery | At startup, tasks left running are paused with a reason; unfinished runs become *interrupted*. The task view shows a summary built from records and the files now: done/remaining steps, findings, files changed since the checkpoint, pending approvals that no longer apply, whether the last verification is current, the next step. Resuming rebuilds the agent's context from the evidence log. | `service.ts` |

## Verified

- `src/test/workspace.test.ts` (28 tests, temp dirs only):
  - lifecycle, restart persistence, boundary, symlinks, protected files and indexing;
  - state machine and false completion;
  - the full investigate → fix → approve → test → complete workflow with a real failing then passing `node test.js`;
  - denial, injection, invalid output, edits on changed files, provider failure;
  - revert and conflicts, staleness, timeout/cancel, no-shell/no-secrets environment;
  - isolation, execution-time permissions, crash recovery, read-only git.
- `src/test/workspaceUi.test.tsx` (6 tests): empty, failure, populated, open task and approve, missing folder, live refresh.
- `scripts/smoke-workspace.sh` (in the release gate) runs the **real Electron app twice** with two real folders and the Anthropic-wire stand-in as the model:
  - the agent plans, runs the failing test and reads the source, proposes the fix, and the app quits with the approval pending;
  - after relaunch, the task is waiting with a recovery summary;
  - approving writes the file, the test really runs and passes, and the task completes;
  - project B sees nothing, a later edit blocks revert and marks the pass out of date, and `.env` is untouched.

## Not done / limitations

- **No real model has driven the agent.** The scripted stand-in follows the protocol; how well a real model plans and fixes is unmeasured (needs an API key).
- macOS only by hand. Windows: commands go through `spawn` (`.cmd` shims for npm/npx via a quoted shell); the process-group kill on timeout is POSIX-only (Windows kills the direct child). Not run on Windows.
- The agent can't run while the task waits; there is one run per task, and no concurrent runs on overlapping files (writes to a file in flight are refused).
- Edits are whole-file proposals; large files (>400 KB) can't be edited through the agent.
- `.gitignore` support covers common patterns, not every edge case (no nested `.gitignore` files).
- Agent-vs-user attribution in Git status uses the change ledger's paths; a file the agent changed and the user also edited shows as *agent*.
- The "ask once per task" edit policy is stored but not yet used: every edit is approved individually.
