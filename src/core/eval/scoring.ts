// Assertion evaluation and run summaries. Every check reports what it observed, so a failure can
// be inspected without re-running the case.

import { truncate } from "../context/text";
import type { Assertion, CaseResult, CheckResult, Metric, RunSummary } from "./types";

export interface Observation {
  outcome: CaseResult["outcome"];
  errorCode?: string;
  retries: number;
  intent?: { category: string; relation: string; ambiguous: boolean };
  system: string;
  user: string;
  historyMessages: number;
  references: { label: string; kind: string }[];
  warnings: string[];
  availabilityTranscript: "live" | "none" | null;
  verificationFlags: string[];
  answer: string;
}

const show = (s: string, n = 160) => JSON.stringify(truncate(s.replace(/\s+/g, " "), n));

function contains(hay: string, needle: string, ignoreCase?: boolean) {
  return ignoreCase ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
}

function range(n: number, min?: number, max?: number) {
  return (min === undefined || n >= min) && (max === undefined || n <= max);
}

const rangeText = (min?: number, max?: number) => (min !== undefined && max !== undefined ? `${min}–${max}` : min !== undefined ? `≥ ${min}` : `≤ ${max}`);

function codeBlocks(answer: string) {
  return [...answer.matchAll(/```([\w+#-]*)\n([\s\S]*?)```/g)].map((m) => (m[1] ?? "").toLowerCase());
}

const LANG_ALIASES: Record<string, string[]> = {
  python: ["python", "py"],
  javascript: ["javascript", "js"],
  typescript: ["typescript", "ts"],
  java: ["java"],
  kotlin: ["kotlin", "kt"],
  sql: ["sql", "postgresql", "mysql"],
  go: ["go", "golang"],
  json: ["json"],
};

/** Evaluate one assertion against an observation. Returns pass/fail plus what was seen. */
export function evaluate(a: Assertion, o: Observation): { passed: boolean; detail: string } {
  switch (a.type) {
    case "outcome": {
      const ok = o.outcome === a.expect && (!a.code || o.errorCode === a.code);
      return { passed: ok, detail: `outcome=${o.outcome}${o.errorCode ? ` code=${o.errorCode}` : ""}` };
    }
    case "retries":
      return { passed: range(o.retries, a.min, a.max), detail: `retries=${o.retries} (want ${rangeText(a.min, a.max)})` };
    case "category":
      return { passed: o.intent?.category === a.expect, detail: `category=${o.intent?.category ?? "none"}` };
    case "relation":
      return { passed: o.intent?.relation === a.expect, detail: `relation=${o.intent?.relation ?? "none"}` };
    case "ambiguous":
      return { passed: (o.intent?.ambiguous ?? false) === a.expect, detail: `ambiguous=${o.intent?.ambiguous ?? false}` };
    case "sent_contains":
      return { passed: contains(o.user, a.text, a.ignoreCase), detail: contains(o.user, a.text, a.ignoreCase) ? `found ${show(a.text, 60)}` : `${show(a.text, 60)} not in the request` };
    case "sent_not_contains":
      return { passed: !contains(o.user, a.text, a.ignoreCase), detail: contains(o.user, a.text, a.ignoreCase) ? `request contains ${show(a.text, 60)}` : "absent" };
    case "system_contains":
      return { passed: contains(o.system, a.text, a.ignoreCase), detail: contains(o.system, a.text, a.ignoreCase) ? "found in system instructions" : `${show(a.text, 60)} not in system instructions` };
    case "system_not_contains":
      return { passed: !contains(o.system, a.text, a.ignoreCase), detail: contains(o.system, a.text, a.ignoreCase) ? `system instructions contain ${show(a.text, 60)}` : "absent" };
    case "sources": {
      const n = a.kind ? o.references.filter((r) => r.kind === a.kind).length : o.references.length;
      return { passed: range(n, a.min, a.max), detail: `${n} ${a.kind ?? "source"}(s) sent (want ${rangeText(a.min, a.max)})` };
    }
    case "warning": {
      const re = new RegExp(a.pattern, "i");
      const hit = o.warnings.find((w) => re.test(w));
      return { passed: !!hit, detail: hit ? show(hit) : `no warning matching /${a.pattern}/ (${o.warnings.length} warnings)` };
    }
    case "no_warning":
      return { passed: o.warnings.length === 0, detail: o.warnings.length ? show(o.warnings.join(" | ")) : "none" };
    case "history_messages":
      return { passed: range(o.historyMessages, a.min, a.max), detail: `${o.historyMessages} earlier messages sent (want ${rangeText(a.min, a.max)})` };
    case "sent_chars":
      return { passed: o.user.length <= a.max, detail: `${o.user.length} chars (max ${a.max})` };
    case "availability_transcript":
      return { passed: o.availabilityTranscript === a.expect, detail: `transcript=${o.availabilityTranscript ?? "unknown"}` };
    case "verify_flags": {
      const has = o.verificationFlags.includes(a.check);
      return { passed: has === a.expect, detail: `${a.check} ${has ? "flagged" : "not flagged"} (flags: ${o.verificationFlags.join(", ") || "none"})` };
    }
    case "answer_matches": {
      const ok = new RegExp(a.pattern, a.flags ?? "i").test(o.answer);
      return { passed: ok, detail: ok ? "matched" : `no match for /${a.pattern}/ in ${show(o.answer, 120)}` };
    }
    case "answer_not_matches": {
      const m = new RegExp(a.pattern, a.flags ?? "i").exec(o.answer);
      return { passed: !m, detail: m ? `found ${show(m[0], 80)}` : "absent" };
    }
    case "answer_code_lang": {
      const langs = codeBlocks(o.answer);
      const want = LANG_ALIASES[a.lang] ?? [a.lang];
      return { passed: langs.some((l) => want.includes(l)), detail: `code blocks: ${langs.map((l) => l || "untagged").join(", ") || "none"}` };
    }
    case "answer_has_code": {
      const n = codeBlocks(o.answer).length;
      return { passed: n > 0 === a.expect, detail: `${n} code block(s)` };
    }
    case "answer_cites": {
      const labels = new Set([...o.answer.matchAll(/\[(C\d+)/g)].map((m) => m[1]));
      return { passed: labels.size >= (a.min ?? 1), detail: `cites ${[...labels].join(", ") || "nothing"}` };
    }
    case "answer_no_unknown_citations": {
      const known = new Set(o.references.map((r) => r.label));
      const cited = [...o.answer.matchAll(/\[(C\d+(?:\s*,\s*C\d+)*)\]/g)].flatMap((m) => m[1]!.split(/\s*,\s*/));
      const bad = [...new Set(cited.filter((c) => !known.has(c)))];
      return { passed: bad.length === 0, detail: bad.length ? `unknown: ${bad.join(", ")}` : `ok (${cited.length} citations)` };
    }
    case "answer_max_words": {
      const n = o.answer
        .replace(/```[\s\S]*?```/g, " ")
        .split(/\s+/)
        .filter(Boolean).length;
      return { passed: n <= a.max, detail: `${n} words (max ${a.max})` };
    }
    case "answer_parses_json": {
      const body = /```(?:json)?\n([\s\S]*?)```/.exec(o.answer)?.[1] ?? o.answer;
      try {
        JSON.parse(body.trim());
        return { passed: true, detail: "valid JSON" };
      } catch (e) {
        return { passed: false, detail: `invalid JSON: ${(e as Error).message.slice(0, 80)}` };
      }
    }
  }
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function emptyCounts(): RunSummary["counts"] {
  return { not_run: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0 };
}

export function summarize(results: CaseResult[], selected: string[], repeat: number): RunSummary {
  const counts = emptyCounts();
  const byCategory: RunSummary["byCategory"] = {};
  const byMetric: RunSummary["byMetric"] = {};
  const totals: number[] = [];
  const ttfts: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let costKnown = true;
  for (const r of results) {
    if (r.status === "running") continue;
    counts[r.status]++;
    const c = (byCategory[r.category] ??= { passed: 0, failed: 0, skipped: 0, inconclusive: 0 });
    if (r.status === "passed" || r.status === "failed" || r.status === "skipped" || r.status === "inconclusive") c[r.status]++;
    if (r.status === "passed" || r.status === "failed") {
      for (const ch of r.checks) {
        const m = (byMetric[ch.metric as Metric] ??= { passed: 0, total: 0 });
        m.total++;
        if (ch.passed) m.passed++;
      }
    }
    if (r.outcome === "done") {
      totals.push(r.latency.totalMs);
      if (r.latency.ttftMs != null) ttfts.push(r.latency.ttftMs);
    }
    if (r.usage) {
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
      if (r.usage.costUsd == null) costKnown = false;
      else costUsd += r.usage.costUsd;
    }
  }
  // Cases selected but never started count as not run, so a stopped run cannot look complete.
  const attempted = new Set(results.map((r) => `${r.caseId}#${r.attempt}`));
  for (const id of selected) for (let i = 1; i <= repeat; i++) if (!attempted.has(`${id}#${i}`)) counts.not_run++;
  let stability: RunSummary["stability"];
  if (repeat > 1) {
    const per = new Map<string, { pass: number; runs: number }>();
    for (const r of results) {
      if (r.status !== "passed" && r.status !== "failed") continue;
      const s = per.get(r.caseId) ?? { pass: 0, runs: 0 };
      s.runs++;
      if (r.status === "passed") s.pass++;
      per.set(r.caseId, s);
    }
    stability = [...per].map(([caseId, s]) => ({ caseId, passRate: s.pass / s.runs, runs: s.runs }));
  }
  return {
    counts,
    byCategory,
    byMetric,
    latency: { p50TtftMs: percentile(ttfts, 50), p50TotalMs: percentile(totals, 50), p95TotalMs: percentile(totals, 95), n: totals.length },
    usage: { inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6, costKnown },
    stability,
  };
}

export function checkResults(checks: { scope: "pipeline" | "answer"; check: { assertion: Assertion; metric: Metric; describe: string } }[], o: Observation): CheckResult[] {
  return checks.map(({ scope, check }) => {
    let r: { passed: boolean; detail: string };
    try {
      r = evaluate(check.assertion, o);
    } catch (e) {
      r = { passed: false, detail: `assertion error: ${(e as Error).message}` };
    }
    return { scope, metric: check.metric, describe: check.describe, ...r };
  });
}
