// Baseline vs candidate comparison. Cases are matched by id; a case whose definition changed, or
// that did not reach pass/fail in both runs, is inconclusive rather than counted either way.
// Nothing here picks a winner or changes configuration — it only reports evidence.

import type { CaseResult, EvalRun } from "./types";

export type Verdict = "improved" | "regressed" | "unchanged" | "inconclusive";

export interface CaseComparison {
  caseId: string;
  category: string;
  verdict: Verdict;
  reason: string;
  baseline: { passRate: number | null; runs: number; status: string };
  candidate: { passRate: number | null; runs: number; status: string };
  /** Checks whose outcome flipped (same description in both runs). */
  changedChecks: { describe: string; baseline: boolean; candidate: boolean }[];
}

export interface RunComparison {
  baselineId: string;
  candidateId: string;
  comparable: boolean;
  warnings: string[];
  counts: Record<Verdict, number>;
  cases: CaseComparison[];
  latency: { baselineP50Ms: number | null; candidateP50Ms: number | null; deltaMs: number | null };
  cost: { baselineUsd: number; candidateUsd: number; deltaUsd: number; known: boolean };
}

function group(results: CaseResult[]) {
  const m = new Map<string, CaseResult[]>();
  for (const r of results) m.set(r.caseId, [...(m.get(r.caseId) ?? []), r]);
  return m;
}

function rate(rs: CaseResult[]) {
  const judged = rs.filter((r) => r.status === "passed" || r.status === "failed");
  return { passRate: judged.length ? judged.filter((r) => r.status === "passed").length / judged.length : null, runs: judged.length, status: [...new Set(rs.map((r) => r.status))].join("/") };
}

/** Pass-rate difference needed to call a change with repeats; smaller differences are noise. */
const MIN_DELTA = 0.5;

export function compareRuns(baseline: EvalRun, candidate: EvalRun): RunComparison {
  const warnings: string[] = [];
  let comparable = true;
  if (baseline.config.mode !== candidate.config.mode) {
    comparable = false;
    warnings.push(`Different modes (${baseline.config.mode} vs ${candidate.config.mode}): results measure different things.`);
  }
  // Regressions cannot be hidden by editing a case: a changed definition is reported, not compared.
  const edited = baseline.results.filter((b) => candidate.results.some((c) => c.caseId === b.caseId && c.caseHash !== b.caseHash)).map((b) => b.caseId);
  if (edited.length) warnings.push(`${new Set(edited).size} case definition(s) changed since the baseline (${[...new Set(edited)].slice(0, 5).join(", ")}); they are inconclusive, not passes.`);
  const dropped = [...new Set(baseline.results.map((r) => r.caseId))].filter((id) => !candidate.results.some((c) => c.caseId === id));
  if (dropped.length) warnings.push(`${dropped.length} baseline case(s) were not run in the candidate (${dropped.slice(0, 5).join(", ")}).`);
  if (baseline.benchmarkVersion !== candidate.benchmarkVersion)
    warnings.push(`Benchmark versions differ (${baseline.benchmarkVersion} vs ${candidate.benchmarkVersion}); changed cases are inconclusive.`);
  if (baseline.status !== "complete") warnings.push(`The baseline run is ${baseline.status}.`);
  if (candidate.status !== "complete") warnings.push(`The candidate run is ${candidate.status}; cases it did not finish are inconclusive.`);
  if (candidate.config.mode === "live" && Math.min(baseline.config.repeat, candidate.config.repeat) < 3)
    warnings.push("Live outputs vary. With fewer than 3 repeats a single flip may be noise; re-run with repeats before acting on it.");

  const b = group(baseline.results);
  const c = group(candidate.results);
  const ids = [...new Set([...b.keys(), ...c.keys()])];
  const cases: CaseComparison[] = ids.map((id) => {
    const br = b.get(id) ?? [];
    const cr = c.get(id) ?? [];
    const bs = rate(br);
    const cs = rate(cr);
    const category = (cr[0] ?? br[0])!.category;
    const changedChecks: CaseComparison["changedChecks"] = [];
    if (br[0] && cr[0]) {
      const before = new Map(br[0].checks.map((x) => [x.describe, x.passed]));
      for (const x of cr[0].checks)
        if (before.has(x.describe) && before.get(x.describe) !== x.passed) changedChecks.push({ describe: x.describe, baseline: before.get(x.describe)!, candidate: x.passed });
    }
    const out = (verdict: Verdict, reason: string): CaseComparison => ({ caseId: id, category, verdict, reason, baseline: bs, candidate: cs, changedChecks });
    if (!comparable) return out("inconclusive", "Runs are not comparable.");
    if (!br.length) return out("inconclusive", "Not in the baseline.");
    if (!cr.length) return out("inconclusive", "Not in the candidate.");
    if (br[0]!.caseHash !== cr[0]!.caseHash) return out("inconclusive", "The case definition changed between runs.");
    if (bs.passRate == null || cs.passRate == null)
      return out("inconclusive", `Not judged in ${bs.passRate == null ? "the baseline" : "the candidate"} (${bs.passRate == null ? bs.status : cs.status}).`);
    const d = cs.passRate - bs.passRate;
    if (d === 0) return out("unchanged", bs.passRate === 1 ? "Passes in both." : bs.passRate === 0 ? "Fails in both." : `Same pass rate (${Math.round(bs.passRate * 100)}%).`);
    const single = bs.runs === 1 && cs.runs === 1;
    if (single || Math.abs(d) >= MIN_DELTA) return out(d > 0 ? "improved" : "regressed", `Pass rate ${Math.round(bs.passRate * 100)}% → ${Math.round(cs.passRate * 100)}%.`);
    return out("inconclusive", `Pass rate ${Math.round(bs.passRate * 100)}% → ${Math.round(cs.passRate * 100)}%: within run-to-run variation.`);
  });
  const counts: Record<Verdict, number> = { improved: 0, regressed: 0, unchanged: 0, inconclusive: 0 };
  for (const x of cases) counts[x.verdict]++;
  const order: Record<Verdict, number> = { regressed: 0, improved: 1, inconclusive: 2, unchanged: 3 };
  cases.sort((x, y) => order[x.verdict] - order[y.verdict] || x.caseId.localeCompare(y.caseId));
  const bl = baseline.summary.latency.p50TotalMs;
  const cl = candidate.summary.latency.p50TotalMs;
  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    comparable,
    warnings,
    counts,
    cases,
    latency: { baselineP50Ms: bl, candidateP50Ms: cl, deltaMs: bl != null && cl != null ? cl - bl : null },
    cost: {
      baselineUsd: baseline.summary.usage.costUsd,
      candidateUsd: candidate.summary.usage.costUsd,
      deltaUsd: Math.round((candidate.summary.usage.costUsd - baseline.summary.usage.costUsd) * 1e6) / 1e6,
      known: baseline.summary.usage.costKnown && candidate.summary.usage.costKnown,
    },
  };
}
