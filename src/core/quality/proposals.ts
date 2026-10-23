// Evidence-driven improvement proposals. Each detector looks at recorded events, feedback and
// evaluation runs, and only raises a proposal above a minimum sample size. Proposals are text for
// a developer to review — nothing here changes settings, prompts or code.

import type { EvalRun } from "../eval/types";
import type { RunComparison } from "../eval/compare";

export interface Proposal {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  /** Observed evidence, with counts. */
  evidence: string[];
  sampleSize: number;
  /** Below the confident threshold: worth watching, not acting on alone. */
  preliminary: boolean;
  categories: string[];
  rootCauses: string[];
  suggestion: string;
  benefits: string;
  risks: string;
  verification: string;
  /** Priority = severity × frequency ÷ effort (1–3). Higher first. */
  priority: number;
  effort: 1 | 2 | 3;
}

export interface ProposalInput {
  events: { type: string; provider: string | null; model: string | null; category: string | null; code: string | null; latencyMs: number | null; detail: string | null }[];
  feedback: { kind: string; meta: { category: string | null; model: string | null; contextSources: string[] } }[];
  /** Latest complete deterministic run, and the comparison with the baseline when both exist. */
  latestRun?: EvalRun | null;
  baselineComparison?: RunComparison | null;
}

/** Minimum observations before a rate-based finding is raised at all; below CONFIDENT it is preliminary. */
const MIN_SAMPLE = 5;
const CONFIDENT = 30;
const SEV = { high: 3, medium: 2, low: 1 } as const;

export function buildProposals(i: ProposalInput): Proposal[] {
  const out: Proposal[] = [];
  const add = (p: Omit<Proposal, "priority" | "preliminary"> & { frequency: number }) => {
    const { frequency, ...rest } = p;
    out.push({ ...rest, preliminary: p.sampleSize < CONFIDENT, priority: Math.round(((SEV[p.severity] * Math.max(0.1, frequency)) / p.effort) * 100) / 100 });
  };
  const requests = i.events.filter((e) => e.type === "request_completed" || e.type === "request_failed" || e.type === "request_cancelled");

  // 1. Benchmark regressions vs the baseline — always reported, regardless of usage volume.
  const cmp = i.baselineComparison;
  if (cmp && cmp.counts.regressed > 0) {
    const reg = cmp.cases.filter((c) => c.verdict === "regressed");
    add({
      id: "eval-regression",
      title: `${reg.length} benchmark case${reg.length === 1 ? "" : "s"} regressed against the baseline`,
      severity: "high",
      evidence: reg.slice(0, 8).map((c) => `${c.caseId}: ${c.reason}${c.changedChecks.length ? ` (${c.changedChecks.map((x) => x.describe).join("; ")})` : ""}`),
      sampleSize: cmp.cases.length,
      categories: [...new Set(reg.map((c) => c.category))],
      rootCauses: ["A change to prompts, context selection, routing or verification since the baseline run."],
      suggestion: "Inspect the flipped checks in Evaluation Lab → Compare, find the change that caused them (git log since the baseline), and fix or revert it.",
      benefits: "Prevents shipping a known quality regression.",
      risks: "None in fixing; accepting the regression needs an explicit decision recorded with the new baseline.",
      verification: "Re-run the deterministic benchmark; the comparison must show 0 regressions.",
      effort: 1,
      frequency: 1,
    });
  }

  // 2. Failures by provider and code.
  const byProvider = new Map<string, { n: number; failed: Map<string, number> }>();
  for (const e of requests) {
    const k = e.provider ?? "unknown";
    const r = byProvider.get(k) ?? { n: 0, failed: new Map() };
    r.n++;
    if (e.type === "request_failed") r.failed.set(e.code ?? "unknown", (r.failed.get(e.code ?? "unknown") ?? 0) + 1);
    byProvider.set(k, r);
  }
  for (const [prov, r] of byProvider) {
    const failed = [...r.failed.values()].reduce((a, b) => a + b, 0);
    if (r.n < MIN_SAMPLE || failed / r.n < 0.15) continue;
    const top = [...r.failed].sort((a, b) => b[1] - a[1]);
    const code = top[0]![0];
    const fix: Record<string, string> = {
      auth: "The key is being rejected: re-enter it in AI provider settings and run Test connection.",
      rate_limited: "Requests are being rate-limited: lower concurrency, enable the response cache, or route quick questions to a local model.",
      timeout: "Requests time out: lower max output tokens or context size, or raise the timeout; check the provider's status.",
      network: "Network failures: check connectivity; consider Cloud first with cloud → local fallback so answers continue offline.",
      context_too_large: "Requests exceed the model's context: lower 'Max context per question' or raise the local context size.",
      spend_limit: "Budgets are being hit: review the usage report before raising limits.",
      routing_blocked: "Privacy restriction blocks requests with no local model ready: set up a local model or adjust what may go to the cloud.",
    };
    add({
      id: `provider-errors-${prov}`,
      title: `${prov}: ${Math.round((failed / r.n) * 100)}% of requests failed (mostly ${code})`,
      severity: failed / r.n >= 0.3 ? "high" : "medium",
      evidence: top.map(([c, n]) => `${n} × ${c}`).concat(`${failed} of ${r.n} requests in the window`),
      sampleSize: r.n,
      categories: [],
      rootCauses: [code === "auth" ? "Invalid or revoked credentials." : code === "rate_limited" ? "Provider quota or burst limits." : "Provider availability, network, or request size."],
      suggestion: fix[code] ?? "Inspect the failing requests in Diagnostics → Recent requests.",
      benefits: "Fewer failed questions.",
      risks: "Raising limits or retries increases cost.",
      verification: "Error rate for this provider falls below 5% over the next 30 requests.",
      effort: 1,
      frequency: failed / r.n,
    });
  }

  // 3. Latency outliers per category.
  const lat = new Map<string, number[]>();
  for (const e of i.events)
    if (e.type === "request_completed" && e.latencyMs != null && e.detail !== "cached") lat.set(e.category ?? "general", [...(lat.get(e.category ?? "general") ?? []), e.latencyMs]);
  const all = [...lat.values()].flat().sort((a, b) => a - b);
  const overall = all.length ? all[Math.floor(all.length / 2)]! : null;
  for (const [cat, xs] of lat) {
    if (xs.length < MIN_SAMPLE || overall == null) continue;
    const s = [...xs].sort((a, b) => a - b);
    const p50 = s[Math.floor(s.length / 2)]!;
    if (p50 < 2 * overall || p50 < 8000) continue;
    add({
      id: `latency-${cat}`,
      title: `${cat} answers are slow (median ${(p50 / 1000).toFixed(1)} s vs ${(overall / 1000).toFixed(1)} s overall)`,
      severity: "medium",
      evidence: [`${xs.length} completed ${cat} requests; median ${p50} ms`],
      sampleSize: xs.length,
      categories: [cat],
      rootCauses: ["Larger answers at deeper depth", "More context sent for this task", "A slower model routed for this category"],
      suggestion: "Compare 'Context budget 60k vs 8k' and lower effort for this category in the Evaluation Lab; check whether answers in this category hit 'too long for depth'.",
      benefits: "Faster answers for this task type.",
      risks: "Less context or effort can reduce quality; verify on the benchmark before changing defaults.",
      verification: "Median latency for this category drops with no benchmark regressions in its cases.",
      effort: 2,
      frequency: xs.length / Math.max(1, all.length),
    });
  }

  // 4. Recurring verification findings.
  const ver = new Map<string, { n: number; cats: Set<string> }>();
  for (const e of i.events)
    if (e.type === "verification_flagged" && e.code) {
      const v = ver.get(e.code) ?? { n: 0, cats: new Set() };
      v.n++;
      if (e.category) v.cats.add(e.category);
      ver.set(e.code, v);
    }
  const completed = i.events.filter((e) => e.type === "request_completed").length;
  for (const [check, v] of ver) {
    if (v.n < MIN_SAMPLE || completed === 0 || v.n / completed < 0.1) continue;
    add({
      id: `verify-${check}`,
      title: `Answer check “${check}” fires on ${Math.round((v.n / completed) * 100)}% of answers`,
      severity: check === "unknown_citation" || check === "claims_unavailable_source" || check === "claims_execution" ? "high" : "low",
      evidence: [`${v.n} of ${completed} completed answers`, `categories: ${[...v.cats].join(", ") || "—"}`],
      sampleSize: completed,
      categories: [...v.cats],
      rootCauses: ["The prompt rule for this behaviour is not followed by the model in use", "The check has false positives"],
      suggestion: `Add or tighten a benchmark case for ${check} (live mode) and compare prompt versions; if the check is wrong, fix it in verify.ts with a regression test.`,
      benefits: "More trustworthy answers.",
      risks: "Prompt changes can affect other categories — run the full benchmark.",
      verification: "Flag rate falls in the next 30 answers and the benchmark shows no regressions.",
      effort: 2,
      frequency: v.n / completed,
    });
  }

  // 5. Negative feedback concentrated in a category or with a context source.
  const neg = i.feedback.filter((f) => f.kind !== "helpful");
  const total = i.feedback.length;
  const byCat = new Map<string, { neg: number; total: number; kinds: Map<string, number> }>();
  for (const f of i.feedback) {
    const c = f.meta.category ?? "general";
    const r = byCat.get(c) ?? { neg: 0, total: 0, kinds: new Map() };
    r.total++;
    if (f.kind !== "helpful") {
      r.neg++;
      r.kinds.set(f.kind, (r.kinds.get(f.kind) ?? 0) + 1);
    }
    byCat.set(c, r);
  }
  for (const [cat, r] of byCat) {
    if (r.neg < MIN_SAMPLE || r.neg / r.total < 0.5) continue;
    const top = [...r.kinds].sort((a, b) => b[1] - a[1]);
    add({
      id: `feedback-${cat}`,
      title: `${cat}: ${r.neg} of ${r.total} ratings were negative (mostly “${top[0]![0].replace("_", " ")}”)`,
      severity: top[0]![0] === "incorrect" ? "high" : "medium",
      evidence: top.map(([k, n]) => `${n} × ${k}`),
      sampleSize: r.total,
      categories: [cat],
      rootCauses:
        top[0]![0] === "irrelevant_context"
          ? ["Ranking includes weakly related sources", "Retrieval query too broad for follow-ups"]
          : top[0]![0] === "too_verbose"
            ? ["Depth defaults too high for this task"]
            : ["Model or prompt weak for this task type"],
      suggestion: "Turn the flagged answers into benchmark cases (Quality → Feedback → Create test case), then compare prompt/context variants on them.",
      benefits: "Targets the tasks users actually find wrong.",
      risks: "Feedback is subjective and from one person; confirm with objective checks before changing defaults.",
      verification: "New user cases pass, and the share of negative feedback for this category falls.",
      effort: 2,
      frequency: r.neg / Math.max(1, total),
    });
  }
  const irrelevant = neg.filter((f) => f.kind === "irrelevant_context");
  if (irrelevant.length >= MIN_SAMPLE) {
    const src = new Map<string, number>();
    for (const f of irrelevant) for (const s of f.meta.contextSources) src.set(s, (src.get(s) ?? 0) + 1);
    add({
      id: "irrelevant-context",
      title: `Irrelevant context reported ${irrelevant.length} times`,
      severity: "medium",
      evidence: [...src].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${n} × included ${s}`),
      sampleSize: irrelevant.length,
      categories: [...new Set(irrelevant.map((f) => f.meta.category ?? "general"))],
      rootCauses: ["Relevance cut (score > 0.6) too permissive for this source kind", "Explicit items always included"],
      suggestion: "Add context_retrieval cases reproducing it and compare a stricter relevance threshold in an experiment.",
      benefits: "Shorter, more focused requests (also cheaper).",
      risks: "A stricter cut can drop useful context — the existing ctx-* cases guard that.",
      verification: "ctx-* cases still pass; new cases pass.",
      effort: 2,
      frequency: irrelevant.length / Math.max(1, total),
    });
  }

  // 6. Benchmark failures in the latest run (independent of the baseline).
  const run = i.latestRun;
  if (run) {
    const failed = run.results.filter((r) => r.status === "failed");
    if (failed.length) {
      add({
        id: "eval-failures",
        title: `${failed.length} case${failed.length === 1 ? "" : "s"} failing in the latest ${run.config.mode} run`,
        severity: run.config.mode === "deterministic" ? "high" : "medium",
        evidence: failed.slice(0, 8).map(
          (r) =>
            `${r.caseId}: ${r.checks
              .filter((c) => !c.passed)
              .map((c) => c.describe)
              .join("; ")}`,
        ),
        sampleSize: run.results.length,
        categories: [...new Set(failed.map((r) => r.category))],
        rootCauses: ["See the failed checks per case"],
        suggestion: "Open the run in the Evaluation Lab and inspect the input and output of each failed case.",
        benefits: "Fixes known failures.",
        risks: "—",
        verification: "The cases pass on re-run.",
        effort: 2,
        frequency: failed.length / Math.max(1, run.results.length),
      });
    }
  }

  return out.sort((a, b) => b.priority - a.priority);
}
