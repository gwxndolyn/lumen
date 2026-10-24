// Reviewer-side triage of beta reports. Runs on a team member's machine through
// scripts/triage.mjs, never inside the shipped app (the desktop UI has no access to other
// people's reports). State is a JSON workspace directory the team keeps somewhere access-controlled
// (docs/BETA_PROGRAMME.md §3): reports/ holds imported, re-validated reports; issues.json holds
// issues and an append-only audit log.
//
// Rules this module enforces (tested):
// - An issue's frequency is the number of distinct imported reports linked to it — an observed
//   count, never an estimate. Issues without a linked report are "hypothesis" until one is linked
//   or a reproduction is recorded.
// - Priority = class order (security/privacy first … cosmetic last), then reproducibility, then
//   observed frequency. Severity from the reporter is an input, not the verdict.
// - "verified" needs a recorded fix, a regression test reference, and a passing verification.
// - Text from reports is data. It is scrubbed on import and shown escaped; nothing in it is
//   executed or interpreted as a command.

import { createHash } from "node:crypto";
import { scrubText, type BetaReport, type ReportCategory } from "./report";

export const TRIAGE_SCHEMA_VERSION = 1;

/** Initial priority order (docs/BETA_PROGRAMME.md §4). Lower = more urgent. */
export const CLASSES = ["security_privacy", "data_loss_crash", "core_broken", "ai_behavior", "performance", "usability", "feature_cosmetic"] as const;
export type IssueClass = (typeof CLASSES)[number];

export const CLASS_LABELS: Record<IssueClass, string> = {
  security_privacy: "Security or privacy",
  data_loss_crash: "Data loss, crash or corrupted state",
  core_broken: "Broken core functionality",
  ai_behavior: "Incorrect or unreliable AI behaviour",
  performance: "Performance or reliability",
  usability: "Usability or accessibility",
  feature_cosmetic: "Feature request or cosmetic",
};

/** Default class for a report category; a reviewer can change it. */
export const CATEGORY_CLASS: Record<ReportCategory, IssueClass> = {
  privacy: "security_privacy",
  crash: "data_loss_crash",
  broken: "core_broken",
  capture: "core_broken",
  answer_quality: "ai_behavior",
  performance: "performance",
  confusing: "usability",
  missing_feature: "feature_cosmetic",
  feature_request: "feature_cosmetic",
  usefulness: "usability",
  other: "usability",
};

export const STATUSES = ["new", "needs_info", "reproducing", "confirmed", "fix_in_progress", "fixed", "verified", "unresolved", "wont_fix", "duplicate"] as const;
export type IssueStatus = (typeof STATUSES)[number];
const OPEN: IssueStatus[] = ["new", "needs_info", "reproducing", "confirmed", "fix_in_progress", "fixed", "unresolved"];

/** Root-cause buckets for AI-behaviour issues: decide where the fault is before touching prompts. */
export const AI_ROOT_CAUSES = ["context_selection", "prompt_construction", "provider_behavior", "model_limitation", "rendering", "user_expectation", "unknown"] as const;

export interface Issue {
  id: string;
  title: string;
  class: IssueClass;
  status: IssueStatus;
  /** Reporter severity, highest seen among linked reports. */
  reportedSeverity: "blocker" | "major" | "minor" | null;
  userImpact: string | null;
  reproSteps: string | null;
  reproduction: { result: "reproduced" | "not_reproduced" | "not_attempted"; notes: string; at: string; version: string | null } | null;
  affectedVersions: string[];
  /** Imported report ids. Frequency is derived from this list. */
  reports: string[];
  related: string[];
  duplicateOf: string | null;
  suspectedRootCause: string | null;
  aiRootCause: (typeof AI_ROOT_CAUSES)[number] | null;
  proposedFix: string | null;
  fix: { commit: string; note: string } | null;
  /** A test file / name, or a regression case id from regression-cases.json. */
  regressionTests: string[];
  verification: { result: "passed" | "failed"; version: string; notes: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  at: string;
  issue: string | null;
  action: string;
  detail: string;
}

export interface TriageState {
  kind: "lumen-triage";
  schemaVersion: number;
  nextIssue: number;
  issues: Issue[];
  /** Imported report ids → their short metadata (the full reports are in reports/). */
  reports: Record<string, { category: ReportCategory; version: string; platform: string; importedAt: string; hash: string; issue: string | null }>;
  audit: AuditEntry[];
}

export function emptyState(): TriageState {
  return { kind: "lumen-triage", schemaVersion: TRIAGE_SCHEMA_VERSION, nextIssue: 1, issues: [], reports: {}, audit: [] };
}

export function loadState(raw: string | null): TriageState {
  if (!raw) return emptyState();
  const s = JSON.parse(raw) as TriageState;
  if (s.kind !== "lumen-triage") throw new Error("Not a Lumen triage workspace (issues.json).");
  if (s.schemaVersion > TRIAGE_SCHEMA_VERSION) throw new Error(`issues.json uses schema ${s.schemaVersion}; this tool understands ${TRIAGE_SCHEMA_VERSION}. Update the tool.`);
  if (!Array.isArray(s.issues) || typeof s.reports !== "object" || !Array.isArray(s.audit)) throw new Error("issues.json is malformed.");
  return s;
}

const iso = (now: Date) => now.toISOString();
const log = (s: TriageState, now: Date, issue: string | null, action: string, detail: string) => s.audit.push({ at: iso(now), issue, action, detail: detail.slice(0, 500) });

export function reportHash(r: BetaReport): string {
  // Content hash of what the reporter wrote; identical re-sends of the same report are detected.
  return createHash("sha256")
    .update(JSON.stringify([r.category, r.description, r.steps, r.app.version]))
    .digest("hex")
    .slice(0, 16);
}

export type ImportResult = { status: "imported"; issue: string; duplicateOf: string | null } | { status: "already_imported"; issue: string | null } | { status: "same_content"; existing: string };

/**
 * Import a validated report: record it, and either attach it to `attachTo` or open a new issue.
 * A report whose id was already imported is a no-op; a different id with the same content is
 * flagged as a probable duplicate (not silently counted twice).
 */
export function importReport(s: TriageState, r: BetaReport, now: Date, attachTo?: string): ImportResult {
  if (s.reports[r.id]) return { status: "already_imported", issue: s.reports[r.id]!.issue };
  const hash = reportHash(r);
  const same = Object.entries(s.reports).find(([, m]) => m.hash === hash);
  if (same && !attachTo) return { status: "same_content", existing: same[0] };
  let issue: Issue;
  if (attachTo) {
    issue = getIssue(s, attachTo);
    issue.reports.push(r.id);
    if (!issue.affectedVersions.includes(r.app.version)) issue.affectedVersions.push(r.app.version);
    issue.reportedSeverity = maxSeverity(issue.reportedSeverity, r.severity);
    issue.updatedAt = iso(now);
  } else {
    issue = {
      id: `BETA-${String(s.nextIssue++).padStart(3, "0")}`,
      title: scrubText(r.description.split("\n")[0]!, "", 100) || r.category,
      class: CATEGORY_CLASS[r.category],
      status: "new",
      reportedSeverity: r.severity,
      userImpact: null,
      reproSteps: r.steps,
      reproduction: null,
      affectedVersions: [r.app.version],
      reports: [r.id],
      related: [],
      duplicateOf: null,
      suspectedRootCause: null,
      aiRootCause: null,
      proposedFix: null,
      fix: null,
      regressionTests: [],
      verification: null,
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    s.issues.push(issue);
  }
  s.reports[r.id] = { category: r.category, version: r.app.version, platform: r.app.platform, importedAt: iso(now), hash, issue: issue.id };
  log(s, now, issue.id, "import", `report ${r.id} (${r.category}, ${r.app.version}, ${r.app.platform})`);
  return { status: "imported", issue: issue.id, duplicateOf: null };
}

function maxSeverity(a: Issue["reportedSeverity"], b: Issue["reportedSeverity"]): Issue["reportedSeverity"] {
  const order = { blocker: 3, major: 2, minor: 1 } as const;
  if (!a) return b;
  if (!b) return a;
  return order[a] >= order[b] ? a : b;
}

export function getIssue(s: TriageState, id: string): Issue {
  const i = s.issues.find((x) => x.id === id);
  if (!i) throw new Error(`No issue ${id}.`);
  return i;
}

const TEXT_FIELDS = ["title", "userImpact", "reproSteps", "suspectedRootCause", "proposedFix"] as const;

/** Update reviewer-owned fields. Values are validated; status rules are enforced. */
export function updateIssue(s: TriageState, id: string, patch: Record<string, string>, now: Date): Issue {
  const i = getIssue(s, id);
  for (const [k, v] of Object.entries(patch)) {
    if ((TEXT_FIELDS as readonly string[]).includes(k)) {
      (i as unknown as Record<string, unknown>)[k] = v ? scrubText(v, "", 2000) : null;
    } else if (k === "class") {
      if (!(CLASSES as readonly string[]).includes(v)) throw new Error(`class must be one of ${CLASSES.join(", ")}`);
      i.class = v as IssueClass;
    } else if (k === "aiRootCause") {
      if (!(AI_ROOT_CAUSES as readonly string[]).includes(v)) throw new Error(`aiRootCause must be one of ${AI_ROOT_CAUSES.join(", ")}`);
      i.aiRootCause = v as Issue["aiRootCause"];
    } else if (k === "status") {
      setStatus(i, v as IssueStatus);
    } else throw new Error(`Unknown field "${k}".`);
    log(s, now, id, `set ${k}`, v);
  }
  i.updatedAt = iso(now);
  return i;
}

function setStatus(i: Issue, v: IssueStatus) {
  if (!(STATUSES as readonly string[]).includes(v)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  if (v === "duplicate") throw new Error("Use `dup` to mark a duplicate (it records which issue).");
  if (v === "verified") throw new Error("Use `verify` to mark an issue verified (it records the result).");
  if (v === "fixed" && !i.fix) throw new Error("Record the fix first (`fix <id> --commit …`).");
  i.status = v;
}

export function recordReproduction(s: TriageState, id: string, result: "reproduced" | "not_reproduced", notes: string, version: string | null, now: Date) {
  const i = getIssue(s, id);
  i.reproduction = { result, notes: scrubText(notes, "", 2000), at: iso(now), version };
  if (result === "reproduced" && (i.status === "new" || i.status === "reproducing" || i.status === "needs_info")) i.status = "confirmed";
  i.updatedAt = iso(now);
  log(s, now, id, "reproduction", `${result}${version ? ` on ${version}` : ""}`);
}

export function recordFix(s: TriageState, id: string, commit: string, note: string, tests: string[], now: Date) {
  const i = getIssue(s, id);
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("--commit must be a git commit hash.");
  if (!tests.length) throw new Error("A fix needs at least one regression test (--test <file or case id>).");
  i.fix = { commit, note: scrubText(note, "", 1000) };
  for (const t of tests) if (!i.regressionTests.includes(t)) i.regressionTests.push(t.slice(0, 200));
  i.status = "fixed";
  i.updatedAt = iso(now);
  log(s, now, id, "fix", `${commit} tests=${tests.join(",")}`);
}

/**
 * Record verification of a fix in a build. Passing needs a fix and a regression test; a failure
 * reopens the issue as unresolved (the evidence is kept either way).
 */
export function recordVerification(s: TriageState, id: string, result: "passed" | "failed", version: string, notes: string, now: Date) {
  const i = getIssue(s, id);
  if (result === "passed") {
    if (!i.fix) throw new Error("Nothing to verify: no fix is recorded.");
    if (!i.regressionTests.length) throw new Error("A verified issue needs a regression test.");
  }
  i.verification = { result, version, notes: scrubText(notes, "", 1000), at: iso(now) };
  i.status = result === "passed" ? "verified" : "unresolved";
  i.updatedAt = iso(now);
  log(s, now, id, "verify", `${result} on ${version}`);
}

export function markDuplicate(s: TriageState, id: string, of: string, now: Date) {
  if (id === of) throw new Error("An issue can't duplicate itself.");
  const dup = getIssue(s, id);
  const target = getIssue(s, of);
  if (target.duplicateOf) throw new Error(`${of} is itself a duplicate of ${target.duplicateOf}; link to that instead.`);
  dup.duplicateOf = of;
  dup.status = "duplicate";
  // Move the evidence: frequency counts the reports, wherever they were first filed.
  for (const r of dup.reports) {
    if (!target.reports.includes(r)) target.reports.push(r);
    if (s.reports[r]) s.reports[r]!.issue = of;
  }
  for (const v of dup.affectedVersions) if (!target.affectedVersions.includes(v)) target.affectedVersions.push(v);
  target.reportedSeverity = maxSeverity(target.reportedSeverity, dup.reportedSeverity);
  dup.reports = [];
  dup.updatedAt = target.updatedAt = iso(now);
  log(s, now, id, "duplicate", `of ${of}`);
}

export function linkIssues(s: TriageState, a: string, b: string, now: Date) {
  const x = getIssue(s, a);
  const y = getIssue(s, b);
  if (!x.related.includes(b)) x.related.push(b);
  if (!y.related.includes(a)) y.related.push(a);
  log(s, now, a, "link", b);
}

/** Possible duplicates: open issues sharing the class and several distinctive title words. */
export function suggestDuplicates(s: TriageState, id: string): { id: string; title: string; shared: string[] }[] {
  const i = getIssue(s, id);
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const mine = words(`${i.title} ${i.reproSteps ?? ""}`);
  return s.issues
    .filter((x) => x.id !== id && !x.duplicateOf && x.class === i.class)
    .map((x) => ({ id: x.id, title: x.title, shared: [...words(`${x.title} ${x.reproSteps ?? ""}`)].filter((w) => mine.has(w)) }))
    .filter((x) => x.shared.length >= 2)
    .sort((a, b) => b.shared.length - a.shared.length);
}

export interface Ranked {
  issue: Issue;
  frequency: number;
  evidence: "observed" | "reproduced" | "hypothesis";
  rank: [number, number, number];
}

/**
 * Open issues in priority order: class, then reproduced-before-unreproduced, then observed report
 * count. Ties keep creation order.
 */
export function prioritise(s: TriageState): Ranked[] {
  return s.issues
    .filter((i) => OPEN.includes(i.status) && !i.duplicateOf)
    .map((i) => {
      const frequency = i.reports.length;
      const reproduced = i.reproduction?.result === "reproduced";
      const evidence: Ranked["evidence"] = reproduced ? "reproduced" : frequency > 0 ? "observed" : "hypothesis";
      return { issue: i, frequency, evidence, rank: [CLASSES.indexOf(i.class), reproduced ? 0 : 1, -frequency] as [number, number, number] };
    })
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
}

/**
 * Summary for a review meeting. Reports counts as observed and says when there are too few
 * reports to read anything into the distribution.
 */
export function summary(s: TriageState, minForTrend = 20) {
  const reports = Object.values(s.reports);
  const byCategory: Record<string, number> = {};
  for (const r of reports) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  const byStatus: Record<string, number> = {};
  for (const i of s.issues) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  const reopened = s.issues.filter((i) => i.verification?.result === "failed").length;
  return {
    reports: reports.length,
    issues: s.issues.length,
    byCategory,
    byStatus,
    verifiedFixes: s.issues.filter((i) => i.status === "verified").length,
    failedVerifications: reopened,
    note:
      reports.length < minForTrend ? `${reports.length} report(s): too few to treat the category mix as a trend (need at least ${minForTrend}). Act on individual high-priority issues instead.` : null,
  };
}

/** Open issues that block a release: security/privacy or data-loss issues that are not verified. */
export function releaseBlockers(s: TriageState): Issue[] {
  return s.issues.filter((i) => !i.duplicateOf && (i.class === "security_privacy" || i.class === "data_loss_crash") && OPEN.includes(i.status));
}
