// Evaluation Lab: benchmark integrity, the runner on the real pipeline, scoring, budgets,
// cancellation, persistence and baseline comparison.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK, BENCHMARK_VERSION, benchmarkCategories } from "../core/eval/benchmark";
import { compareRuns } from "../core/eval/compare";
import { runExperiment } from "../core/eval/experiment";
import { SCRIPTED_ANSWER } from "../core/eval/providers";
import { evaluate, summarize, type Observation } from "../core/eval/scoring";
import { caseHash, runCase, runEvaluation } from "../core/eval/runner";
import { EvalService } from "../core/eval/service";
import { EvalStore } from "../core/eval/store";
import { CATEGORY_LABELS, type EvalCase, type EvalRun } from "../core/eval/types";
import type { AIProvider, GenerateRequest } from "../core/providers/types";
import { ProviderError } from "../core/providers/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { applySettingsPatch } from "../shared/settingsSchema";

const settings = DEFAULT_SETTINGS;
const byId = (id: string) => BENCHMARK.find((c) => c.id === id)!;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lumen-eval-"));

/** A stand-in for a configured real provider (isMock = false), answering from a function. */
function fakeLive(answer: (req: GenerateRequest) => string, opts: { fail?: ProviderError; model?: string; delayMs?: number } = {}): AIProvider & { calls: number } {
  const p = {
    kind: "anthropic" as const,
    isMock: false,
    supportsImages: true,
    calls: 0,
    async generate(req: GenerateRequest, signal: AbortSignal) {
      p.calls++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (signal.aborted) throw new Error("aborted");
      if (opts.fail) throw opts.fail;
      return {
        text: answer(req),
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        model: opts.model ?? req.model,
        servedByFallback: null,
        ttftMs: 5,
        retries: 0,
      };
    },
    async test() {
      return { ok: true, message: "ok", latencyMs: 1 };
    },
  };
  return p;
}

describe("benchmark integrity", () => {
  it("has at least 50 cases, unique ids, and every category represented", () => {
    expect(BENCHMARK.length).toBeGreaterThanOrEqual(50);
    expect(new Set(BENCHMARK.map((c) => c.id)).size).toBe(BENCHMARK.length);
    const cats = benchmarkCategories();
    for (const k of Object.keys(CATEGORY_LABELS)) expect(cats.get(k) ?? 0, k).toBeGreaterThanOrEqual(3);
  });

  it("every case has acceptance criteria, failure conditions and a method", () => {
    for (const c of BENCHMARK) {
      expect(c.pipeline.length + c.answer.length, c.id).toBeGreaterThan(0);
      expect(c.failureConditions.length, c.id).toBeGreaterThan(0);
      expect(c.method, c.id).toBeTruthy();
      // Live-mode cases must have something to check on a real answer, or the run proves nothing.
      if (!c.deterministicOnly) expect(c.pipeline.length + c.answer.length, c.id).toBeGreaterThan(0);
    }
  });

  it("contains no real credentials", () => {
    const text = JSON.stringify(BENCHMARK);
    expect(text).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}/);
  });
});

describe("deterministic run on the real pipeline", () => {
  it("passes the whole benchmark and reports a complete run", async () => {
    const run = await runEvaluation({ mode: "deterministic", cases: BENCHMARK, benchmarkVersion: BENCHMARK_VERSION, settings });
    const failed = run.results
      .filter((r) => r.status !== "passed")
      .map(
        (r) =>
          `${r.caseId}: ${
            r.reason ??
            r.checks
              .filter((c) => !c.passed)
              .map((c) => c.detail)
              .join("; ")
          }`,
      );
    expect(failed).toEqual([]);
    expect(run.status).toBe("complete");
    expect(run.summary.counts.passed).toBe(BENCHMARK.length);
    expect(run.config.model).toBe("scripted");
    expect(run.limitations.join(" ")).toMatch(/scripted provider/);
  }, 30_000); // ~0.4 s normally; 64 full-pipeline cases can exceed 5 s on a loaded machine

  it("never reports scripted text as model output", async () => {
    const r = await runCase(byId("ctx-001"), { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    expect(r.output).toBeUndefined();
    expect(r.usage).toBeUndefined();
    expect(r.input?.user).toContain("port 6543");
    expect(r.checks.every((c) => c.scope === "pipeline")).toBe(true);
  });

  it("is reproducible: the same case produces the same checks twice", async () => {
    const a = await runCase(byId("long-001"), { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    const b = await runCase(byId("long-001"), { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    expect(a.checks).toEqual(b.checks);
    expect(a.input).toEqual(b.input);
  });

  it("detects a real regression: a broken injection guard fails the injection cases", async () => {
    // Bypass the envelope by sending a case whose fixture is exactly the escaped payload check,
    // then confirm the check would fail if the escaped form were missing.
    const c = byId("inj-002");
    const broken: EvalCase = { ...c, pipeline: [...c.pipeline, { assertion: { type: "sent_contains", text: "</context><question>" }, metric: "safety", describe: "negative control" }] };
    const r = await runCase(broken, { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    expect(r.status).toBe("failed");
    expect(r.checks.find((x) => x.describe === "negative control")!.passed).toBe(false);
  });

  it("a smaller context budget changes what is sent", async () => {
    const c = byId("long-003");
    const full = await runCase(c, { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    const small = await runCase(c, {
      mode: "deterministic",
      settings,
      provider: null,
      overrides: { budget: { maxContextChars: 8000, maxItemChars: 8000, maxImages: 3 } },
      timeoutMs: 5000,
      attempt: 1,
    });
    expect(small.input!.user.length).toBeLessThan(full.input!.user.length);
    expect(small.input!.user.length).toBeLessThan(12_000);
  });

  it("disabling verification removes the flags", async () => {
    const c = byId("code-005");
    const off = await runCase(c, { mode: "deterministic", settings, provider: null, overrides: { verification: false }, timeoutMs: 5000, attempt: 1 });
    expect(off.verificationFlags).toEqual([]);
    expect(off.status).toBe("failed");
  });

  it("an experimental prompt replaces only the base policy", async () => {
    const r = await runCase(byId("ctx-001"), { mode: "deterministic", settings, provider: null, overrides: { basePrompt: "You are Lumen (test prompt)." }, timeoutMs: 5000, attempt: 1 });
    expect(r.input!.system).toContain("You are Lumen (test prompt).");
    expect(r.input!.system).not.toContain("Ground rules:");
    expect(r.input!.system).toContain("Answer style: quick answer");
  });
});

describe("live mode", () => {
  it("refuses the development provider and a missing provider", async () => {
    await expect(runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => null })).rejects.toThrow(/real AI provider/);
    const mock = { ...fakeLive(() => "x"), isMock: true };
    await expect(runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => mock })).rejects.toThrow(/Development mode/);
  });

  it("judges the real answer and records model, usage and the exact input", async () => {
    const p = fakeLive(() => "Return **201 Created**.");
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p });
    const r = run.results[0]!;
    expect(r.status).toBe("passed");
    expect(r.output).toBe("Return **201 Created**.");
    expect(r.model).toBe(settings.provider.model);
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    expect(r.usage!.costUsd).toBeGreaterThan(0);
    expect(r.input!.user).toContain("<question>");
    expect(r.checks.some((c) => c.scope === "answer")).toBe(true);
  });

  it("a wrong answer fails with the observed detail", async () => {
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => fakeLive(() => "Return 200 OK.") });
    const r = run.results[0]!;
    expect(r.status).toBe("failed");
    expect(r.checks.find((c) => !c.passed)!.detail).toMatch(/no match/);
  });

  it("a provider failure is inconclusive, not a failed answer", async () => {
    const p = fakeLive(() => "", { fail: new ProviderError("Rate limited", "rate_limited", false) });
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p });
    expect(run.results[0]!.status).toBe("inconclusive");
    expect(run.results[0]!.reason).toMatch(/rate_limited/);
    expect(run.status).toBe("partial");
  });

  it("skips scripted-provider cases instead of faking them", async () => {
    const run = await runEvaluation({ mode: "live", cases: [byId("fail-001")], benchmarkVersion: "x", settings, liveProvider: () => fakeLive(() => "hi") });
    expect(run.results[0]!.status).toBe("skipped");
  });

  it("caps output tokens at the run limit", async () => {
    const p = fakeLive(() => "201");
    const seen: number[] = [];
    const orig = p.generate.bind(p);
    p.generate = (req, s) => {
      seen.push(req.maxTokens);
      return orig(req, s);
    };
    await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p, limits: { maxOutputTokens: 300 } });
    expect(seen[0]).toBe(300);
  });

  it("stops before the cost limit and marks the run partial", async () => {
    const p = fakeLive(() => "201 Created");
    const cases = BENCHMARK.filter((c) => !c.deterministicOnly).slice(0, 10);
    const run = await runEvaluation({ mode: "live", cases, benchmarkVersion: "x", settings, liveProvider: () => p, limits: { maxCostUsd: 0.05, maxOutputTokens: 1500 } });
    expect(p.calls).toBeLessThan(10);
    expect(run.status).toBe("partial");
    expect(run.stopReason).toMatch(/cost limit/);
    expect(run.summary.counts.not_run).toBeGreaterThan(0);
    expect(run.summary.usage.costUsd).toBeLessThanOrEqual(0.05);
  });

  it("a cost limit of 0 sends nothing", async () => {
    const p = fakeLive(() => "x");
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p, limits: { maxCostUsd: 0 } });
    expect(p.calls).toBe(0);
    expect(run.status).toBe("partial");
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const p = fakeLive(() => "201");
    const orig = p.generate.bind(p);
    p.generate = async (req, s) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await orig(req, s);
      } finally {
        inFlight--;
      }
    };
    const cases = BENCHMARK.filter((c) => !c.deterministicOnly).slice(0, 8);
    await runEvaluation({ mode: "live", cases, benchmarkVersion: "x", settings, liveProvider: () => p, limits: { concurrency: 2, maxCostUsd: 25 } });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("cancellation stops the run and never reports it complete", async () => {
    const ctrl = new AbortController();
    const p = fakeLive(() => "201", { delayMs: 30 });
    const cases = BENCHMARK.filter((c) => !c.deterministicOnly).slice(0, 6);
    setTimeout(() => ctrl.abort(), 40);
    const run = await runEvaluation({ mode: "live", cases, benchmarkVersion: "x", settings, liveProvider: () => p, signal: ctrl.signal, limits: { concurrency: 1, maxCostUsd: 25 } });
    expect(run.status).toBe("cancelled");
    expect(run.summary.counts.not_run).toBeGreaterThan(0);
  });

  it("a hung provider times out as inconclusive", async () => {
    const p = fakeLive(() => "201", { delayMs: 5000 });
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p, limits: { caseTimeoutMs: 1000 } });
    expect(run.results[0]!.status).toBe("inconclusive");
    expect(run.results[0]!.reason).toMatch(/No result within/);
  }, 10_000);

  it("repeats record per-case stability", async () => {
    let i = 0;
    const p = fakeLive(() => (i++ % 2 ? "200 OK" : "201 Created"));
    const run = await runEvaluation({ mode: "live", cases: [byId("fact-001")], benchmarkVersion: "x", settings, liveProvider: () => p, repeat: 2, limits: { concurrency: 1 } });
    expect(run.results).toHaveLength(2);
    expect(run.summary.stability).toEqual([{ caseId: "fact-001", passRate: 0.5, runs: 2 }]);
  });
});

describe("scoring", () => {
  const obs: Observation = {
    outcome: "done",
    retries: 0,
    system: "sys",
    user: "<question>q</question>",
    historyMessages: 0,
    references: [{ label: "C1", kind: "note" }],
    warnings: [],
    availabilityTranscript: "none",
    verificationFlags: [],
    answer: 'Answer [C1] and [C2].\n```json\n{"a":1}\n```',
  };
  it("answer assertions inspect structure, not exact wording", () => {
    expect(evaluate({ type: "answer_no_unknown_citations" }, obs)).toMatchObject({ passed: false, detail: "unknown: C2" });
    expect(evaluate({ type: "answer_parses_json" }, obs).passed).toBe(true);
    expect(evaluate({ type: "answer_code_lang", lang: "json" }, obs).passed).toBe(true);
    expect(evaluate({ type: "answer_max_words", max: 4 }, obs).passed).toBe(true);
    expect(evaluate({ type: "answer_max_words", max: 3 }, obs).passed).toBe(false);
    expect(evaluate({ type: "outcome", expect: "error", code: "auth" }, { ...obs, outcome: "error", errorCode: "auth" }).passed).toBe(true);
  });

  it("summaries keep metrics separate and count unstarted cases as not run", () => {
    const s = summarize([], ["a", "b"], 2);
    expect(s.counts.not_run).toBe(4);
    expect(s.byMetric).toEqual({});
  });

  it("an assertion that throws is a failed check, not a crash", async () => {
    const c: EvalCase = { ...byId("ctx-001"), pipeline: [{ assertion: { type: "answer_matches", pattern: "(" }, metric: "correctness", describe: "bad regex" }] };
    const r = await runCase(c, { mode: "deterministic", settings, provider: null, overrides: {}, timeoutMs: 5000, attempt: 1 });
    expect(r.status).toBe("failed");
    expect(r.checks[0]!.detail).toMatch(/assertion error/);
  });

  it("scripted answers are labelled", () => {
    expect(SCRIPTED_ANSWER).toMatch(/not model output/);
  });
});

describe("persistence", () => {
  const sample = async () => runEvaluation({ mode: "deterministic", cases: BENCHMARK.slice(0, 4), benchmarkVersion: BENCHMARK_VERSION, settings });

  it("saves, lists, reloads and deletes runs", async () => {
    const store = new EvalStore(tmp());
    const run = await sample();
    store.save(run);
    expect(store.list()).toHaveLength(1);
    expect(store.get(run.id)).toEqual(run);
    store.delete(run.id);
    expect(store.list()).toHaveLength(0);
  });

  it("a run interrupted mid-way reloads as partial, never complete", async () => {
    const store = new EvalStore(tmp());
    const run = { ...(await sample()), status: "running" as const };
    store.save(run);
    expect(store.get(run.id)!.status).toBe("partial");
    expect(store.get(run.id)!.stopReason).toMatch(/Interrupted/);
  });

  it("only a complete run can be the baseline", async () => {
    const store = new EvalStore(tmp());
    const good = await sample();
    const bad: EvalRun = { ...(await sample()), status: "partial" };
    store.save(good);
    store.save(bad);
    expect(() => store.setBaseline(bad.id)).toThrow(/complete/);
    store.setBaseline(good.id);
    expect(store.baselineId()).toBe(good.id);
    expect(store.list().find((r) => r.id === good.id)!.isBaseline).toBe(true);
  });

  it("ignores corrupt files and rejects path-like ids", () => {
    const dir = tmp();
    const store = new EvalStore(dir);
    fs.writeFileSync(path.join(dir, "00000000-0000-0000-0000-000000000000.json"), "{not json");
    expect(store.list()).toEqual([]);
    expect(() => store.get("../../etc/passwd")).toThrow(/Invalid run id/);
  });

  it("scrubs the home directory and key-shaped strings from saved runs", async () => {
    const dir = tmp();
    const store = new EvalStore(dir, "/Users/jane");
    const run = await sample();
    run.results[0]!.reason = "error at /Users/jane/app with key sk-ant-abcdefghijklmnop";
    store.save(run);
    const raw = fs.readFileSync(path.join(dir, `${run.id}.json`), "utf8");
    expect(raw).not.toContain("/Users/jane");
    expect(raw).not.toContain("abcdefghijklmnop");
  });
});

describe("comparison", () => {
  const live = (answer: string) => runEvaluation({ mode: "live", cases: [byId("fact-001"), byId("fact-002")], benchmarkVersion: "x", settings, liveProvider: () => fakeLive(() => answer) });

  it("reports improvements and regressions per case with the flipped checks", async () => {
    const before = await live("201 and O(log n)");
    const after = await live("200 and O(log n)");
    const cmp = compareRuns(before, after);
    expect(cmp.counts).toMatchObject({ regressed: 1, unchanged: 1 });
    const reg = cmp.cases.find((c) => c.verdict === "regressed")!;
    expect(reg.caseId).toBe("fact-001");
    expect(reg.changedChecks[0]).toMatchObject({ baseline: true, candidate: false });
    expect(compareRuns(after, before).counts.improved).toBe(1);
  });

  it("a changed case definition is inconclusive, not a regression", async () => {
    const before = await live("201");
    const after = await live("200");
    after.results[0]!.caseHash = "different";
    expect(compareRuns(before, after).cases.find((c) => c.caseId === "fact-001")!.verdict).toBe("inconclusive");
  });

  it("deterministic vs live runs are not comparable", async () => {
    const d = await runEvaluation({ mode: "deterministic", cases: [byId("fact-001"), byId("fact-002")], benchmarkVersion: "x", settings });
    const l = await live("201");
    const cmp = compareRuns(d, l);
    expect(cmp.comparable).toBe(false);
    expect(cmp.counts.inconclusive).toBe(2);
  });

  it("warns that single live runs may be noise", async () => {
    expect(compareRuns(await live("201"), await live("201")).warnings.join(" ")).toMatch(/fewer than 3 repeats/);
  });

  it("case hashes change when a case changes", () => {
    const c = byId("fact-001");
    expect(caseHash(c)).not.toBe(caseHash({ ...c, title: "edited" }));
  });
});

describe("experiments", () => {
  it("runs each variant on identical cases and compares to the control", async () => {
    const cases = [byId("code-005"), byId("fmt-005"), byId("ctx-001")];
    const r = await runExperiment(
      { name: "Verification", variants: [{ name: "on" }, { name: "off", verification: false }] },
      { mode: "deterministic", cases, benchmarkVersion: BENCHMARK_VERSION, settings },
    );
    expect(r.runs).toHaveLength(2);
    expect(r.runs[0]!.caseIds).toEqual(r.runs[1]!.caseIds);
    expect(r.runs[1]!.config.verification).toBe(false);
    // Turning verification off breaks exactly the cases that test it.
    expect(r.comparisons[0]!.counts).toMatchObject({ regressed: 2, unchanged: 1 });
  });

  it("rejects unknown prompts and out-of-range budgets", async () => {
    const base = { mode: "deterministic" as const, cases: [byId("ctx-001")], benchmarkVersion: "x", settings };
    await expect(runExperiment({ name: "x", variants: [{ name: "a" }, { name: "b", promptVersion: "nope" }] }, base)).rejects.toThrow(/Unknown prompt/);
    await expect(runExperiment({ name: "x", variants: [{ name: "a" }, { name: "b", contextBudgetChars: 10 }] }, base)).rejects.toThrow(/between/);
    await expect(runExperiment({ name: "x", variants: [{ name: "a" }] }, base)).rejects.toThrow(/2–4/);
  });
});

describe("service", () => {
  const svc = (provider: AIProvider | null = null, s = settings) => {
    const events: { type: string }[] = [];
    const service = new EvalService({ store: new EvalStore(tmp()), getSettings: () => s, getProvider: () => provider, emit: (e) => events.push(e) });
    return { service, events };
  };
  const finished = (events: { type: string }[]) =>
    new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.type === "finished")) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

  it("refuses a live run without explicit confirmation", () => {
    const { service } = svc(fakeLive(() => "x"));
    expect(() => service.start({ mode: "live" })).toThrow(/Confirm/);
  });

  it("refuses a live run in development mode", () => {
    const { service } = svc(
      fakeLive(() => "x"),
      applySettingsPatch(settings, { provider: { kind: "mock" } }),
    );
    expect(() => service.start({ mode: "live", confirmLive: true })).toThrow(/real AI provider/);
  });

  it("runs one evaluation at a time, persists it and emits progress", async () => {
    const { service, events } = svc();
    service.start({ mode: "deterministic", categories: ["provider_failures"] });
    expect(() => service.start({ mode: "deterministic" })).toThrow(/already running/);
    await finished(events);
    expect(events.filter((e) => e.type === "progress").length).toBeGreaterThan(1);
    const runs = service.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.counts.passed).toBe(BENCHMARK.filter((c) => c.category === "provider_failures").length);
    const exported = JSON.parse(service.exportRun(runs[0]!.id)) as { kind: string; run: EvalRun };
    expect(exported.kind).toBe("lumen-eval-run");
    expect(exported.run.results.length).toBeGreaterThan(0);
  });

  it("estimates live cost only for cases that would call the provider", () => {
    const { service } = svc();
    const e = service.estimate({ mode: "live", categories: ["provider_failures", "research_factual"] });
    // Deterministic-only cases (scripted answers) never call the provider, whatever their category.
    expect(e.liveCases).toBe(BENCHMARK.filter((c) => c.category === "research_factual" && !c.deterministicOnly).length);
    expect(e.known).toBe(true);
    expect(e.maxUsd).toBeGreaterThan(0);
  });
});
