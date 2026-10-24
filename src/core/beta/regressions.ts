// Beta regression collection: benchmark cases derived from triaged beta issues. They live in the
// repository (src/core/eval/regression-cases.json) and only cases with status "approved" are run
// by `npm run eval` and the release gate. A proposed case is never trusted until a reviewer
// approves it, and approval records who did it and the exact definition hash, so an approved case
// edited afterwards drops back to "proposed" automatically.
//
// Content rules (enforced by validateRegressionCase, tested):
// - Fixtures are synthetic or sanitised: every string is re-run through credential and sensitive
//   value redaction, and a case whose text still trips the detectors is refused, not silently
//   rewritten into something that no longer reproduces the issue.
// - Each case links to its issue (BETA-nnn) and states whether it is synthetic or derived from a
//   user example; derived cases need a recorded sanitisation note.

import { createHash } from "node:crypto";
import { findSensitive } from "../context/sensitivity";
import { redactCredentials } from "../credentials";
import { validateUserCase } from "../quality/service";
import type { EvalCase } from "../eval/types";

export const REGRESSION_FILE_VERSION = 1;

export interface RegressionEntry {
  /** The benchmark case. Its id must start with "reg-". */
  case: EvalCase;
  issue: string;
  origin: "synthetic" | "sanitized_user_example";
  /** Required for sanitized_user_example: what was removed or replaced, and who checked it. */
  sanitization: string | null;
  status: "proposed" | "approved" | "retired";
  proposedBy: string;
  proposedAt: string;
  approval: { by: string; at: string; hash: string } | null;
  retiredReason?: string | null;
}

export interface RegressionFile {
  kind: "lumen-regression-cases";
  version: number;
  entries: RegressionEntry[];
}

export function definitionHash(c: EvalCase): string {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16);
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/**
 * Validate a regression case. Reuses the user-case validator's structural checks (supported
 * assertion types, regex validity, size limits), then applies the stricter content rule: no string
 * may still contain something that looks like a credential or sensitive value.
 *
 * Cases that test redaction itself need a secret-shaped input; they put FAKE or EXAMPLE (upper
 * case) inside the value, which the secret scanner also treats as a placeholder.
 */
export function validateRegressionCase(e: RegressionEntry): string[] {
  const problems: string[] = [];
  const c = e.case;
  if (!c || typeof c !== "object") return ["missing case"];
  if (!/^reg-[a-z0-9-]{3,40}$/.test(c.id)) problems.push(`${c.id}: regression case ids must start with "reg-"`);
  if (!/^BETA-\d{3,}$|^LUM-\d{3,}$/.test(e.issue)) problems.push(`${c.id}: issue must be a BETA-nnn or LUM-nnn id`);
  if (e.origin === "sanitized_user_example" && !e.sanitization?.trim()) problems.push(`${c.id}: a case derived from a user example needs a sanitization note`);
  if (e.status === "approved" && !e.approval) problems.push(`${c.id}: approved without an approval record`);
  try {
    // validateUserCase requires the user- prefix; check structure under that id.
    validateUserCase({ ...c, id: `user-${c.id.slice(4)}` });
  } catch (err) {
    problems.push(`${c.id}: ${(err as Error).message}`);
  }
  for (const s of strings({ ...c, id: undefined })) {
    if (/FAKE|EXAMPLE/.test(s)) continue;
    if (redactCredentials(s) !== s || findSensitive(s).length)
      problems.push(`${c.id}: contains a value that looks like a credential or personal data; replace it with a synthetic one (mark test secrets FAKE)`);
  }
  return [...new Set(problems)];
}

export interface LoadedRegressions {
  /** Approved cases whose definition matches the approved hash: these are trusted and run. */
  trusted: EvalCase[];
  /** Approved but edited since approval: not run until re-approved. */
  stale: string[];
  proposed: string[];
  invalid: string[];
}

export function loadRegressions(file: RegressionFile | null): LoadedRegressions {
  const out: LoadedRegressions = { trusted: [], stale: [], proposed: [], invalid: [] };
  if (!file) return out;
  if (file.kind !== "lumen-regression-cases" || file.version > REGRESSION_FILE_VERSION) throw new Error("Unsupported regression case file.");
  const ids = new Set<string>();
  for (const e of file.entries ?? []) {
    const problems = validateRegressionCase(e);
    if (ids.has(e.case?.id)) problems.push(`${e.case.id}: duplicate id`);
    ids.add(e.case?.id);
    if (problems.length) {
      out.invalid.push(...problems);
      continue;
    }
    if (e.status === "retired") continue;
    if (e.status === "proposed") out.proposed.push(e.case.id);
    else if (e.approval!.hash !== definitionHash(e.case)) out.stale.push(e.case.id);
    else out.trusted.push(e.case);
  }
  return out;
}

/** Mark a proposed (or stale) entry approved by `by`, pinning the current definition. */
export function approve(file: RegressionFile, caseId: string, by: string, now: Date, opts: { allowSelfApproval?: boolean } = {}): RegressionEntry {
  const e = file.entries.find((x) => x.case.id === caseId);
  if (!e) throw new Error(`No regression case ${caseId}.`);
  if (!by.trim()) throw new Error("Approval needs a reviewer name (--by).");
  if (by.trim() === e.proposedBy && !opts.allowSelfApproval) throw new Error("The person who proposed a case can't approve it. Ask another reviewer.");
  const problems = validateRegressionCase({ ...e, status: "proposed", approval: null });
  if (problems.length) throw new Error(`Fix these first:\n  ${problems.join("\n  ")}`);
  e.status = "approved";
  e.approval = { by: by.trim().slice(0, 80), at: now.toISOString(), hash: definitionHash(e.case) };
  return e;
}
