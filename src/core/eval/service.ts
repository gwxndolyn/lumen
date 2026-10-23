// Evaluation Lab service: one run (or experiment) at a time, progress events, persistence and
// comparison. Live runs require an explicit confirmation flag from the caller, which the UI sets
// only after showing what will be sent and the cost estimate.

import type { AIProvider } from "../providers/types";
import type { Settings } from "../../shared/types";
import { BENCHMARK, BENCHMARK_VERSION } from "./benchmark";
import { compareRuns, type RunComparison } from "./compare";
import { PRESET_EXPERIMENTS, runExperiment, type ExperimentDef } from "./experiment";
import { PROMPT_VERSIONS } from "./prompts";
import { DEFAULT_LIMITS, HARD_LIMITS, estimateRunCostUsd, runEvaluation } from "./runner";
import type { EvalStore } from "./store";
import { CATEGORY_LABELS, METRIC_DEFINITIONS, type EvalCase, type EvalRun, type RunLimits, type Variant } from "./types";

export interface StartRequest {
  mode: "deterministic" | "live";
  caseIds?: string[];
  categories?: string[];
  repeat?: number;
  limits?: Partial<RunLimits>;
  variant?: Variant;
  label?: string;
  /** Required for live runs: the user confirmed sending synthetic benchmark data to their provider. */
  confirmLive?: boolean;
  experiment?: ExperimentDef;
}

export type EvalEvent = { type: "progress"; run: EvalRun } | { type: "finished"; runIds: string[]; error?: string };

export interface EvalServiceDeps {
  store: EvalStore;
  getSettings: () => Settings;
  getProvider: () => AIProvider | null;
  emit: (e: EvalEvent) => void;
  cases?: EvalCase[];
}

export class EvalService {
  private active: AbortController | null = null;
  private readonly cases: EvalCase[];

  constructor(private readonly deps: EvalServiceDeps) {
    this.cases = deps.cases ?? BENCHMARK;
  }

  catalog() {
    return {
      benchmarkVersion: BENCHMARK_VERSION,
      categories: CATEGORY_LABELS,
      metrics: METRIC_DEFINITIONS,
      cases: this.cases,
      prompts: PROMPT_VERSIONS.map(({ id, description }) => ({ id, description })),
      presets: PRESET_EXPERIMENTS,
      defaultLimits: DEFAULT_LIMITS,
      hardLimits: HARD_LIMITS,
    };
  }

  get running(): boolean {
    return this.active !== null;
  }

  select(req: Pick<StartRequest, "caseIds" | "categories">): EvalCase[] {
    let out = this.cases;
    if (req.categories?.length) out = out.filter((c) => req.categories!.includes(c.category));
    if (req.caseIds?.length) out = out.filter((c) => req.caseIds!.includes(c.id));
    return out;
  }

  /** What a live run would cost at most, and which cases would actually call the provider. */
  estimate(req: StartRequest) {
    const settings = this.deps.getSettings();
    const cases = this.select(req).filter((c) => !c.deterministicOnly);
    const maxOut = Math.min(req.limits?.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens, HARD_LIMITS.maxOutputTokens);
    const models = req.experiment ? req.experiment.variants.map((v) => v.model ?? settings.provider.model) : [req.variant?.model ?? settings.provider.model];
    let usd = 0;
    let known = true;
    for (const m of models) {
      const e = estimateRunCostUsd(cases, m, maxOut, req.repeat ?? 1);
      if (!e.known) known = false;
      usd += e.usd;
    }
    return { liveCases: cases.length, calls: cases.length * (req.repeat ?? 1) * models.length, maxUsd: Math.round(usd * 1e4) / 1e4, known, provider: settings.provider.kind, model: models.join(", ") };
  }

  start(req: StartRequest): void {
    if (this.active) throw new Error("An evaluation is already running. Stop it first.");
    if (req.mode === "live" && !req.confirmLive) throw new Error("Live evaluation sends benchmark prompts to your AI provider. Confirm before starting.");
    const settings = this.deps.getSettings();
    if (req.mode === "live" && settings.provider.kind === "mock") throw new Error("Live evaluation needs a real AI provider; development mode cannot produce live results.");
    const cases = this.select(req);
    if (!cases.length) throw new Error("No cases match the selection.");
    if (req.variant?.model && req.mode !== "live") throw new Error("Model variants only apply to live runs.");
    const ctrl = new AbortController();
    this.active = ctrl;
    const base = {
      mode: req.mode,
      cases,
      benchmarkVersion: BENCHMARK_VERSION,
      settings,
      liveProvider: this.deps.getProvider,
      repeat: req.repeat,
      limits: req.limits,
      signal: ctrl.signal,
      onProgress: (run: EvalRun) => {
        this.deps.store.save(run);
        this.deps.emit({ type: "progress", run });
      },
    };
    const job = req.experiment ? runExperiment(req.experiment, base).then((r) => r.runs) : runEvaluation({ ...base, variant: req.variant, label: req.label }).then((r) => [r]);
    void job
      .then((runs) => {
        for (const r of runs) this.deps.store.save(r);
        this.deps.emit({ type: "finished", runIds: runs.map((r) => r.id) });
      })
      .catch((e: Error) => this.deps.emit({ type: "finished", runIds: [], error: e.message }))
      .finally(() => {
        if (this.active === ctrl) this.active = null;
      });
  }

  stop(): boolean {
    if (!this.active) return false;
    this.active.abort();
    return true;
  }

  list() {
    return this.deps.store.list();
  }

  get(id: string) {
    return this.deps.store.get(id);
  }

  delete(id: string) {
    this.deps.store.delete(id);
  }

  clearHistory() {
    this.deps.store.clear();
  }

  setBaseline(id: string | null) {
    this.deps.store.setBaseline(id);
  }

  compare(baselineId: string, candidateId: string): RunComparison {
    const b = this.deps.store.get(baselineId);
    const c = this.deps.store.get(candidateId);
    if (!b || !c) throw new Error("One of the runs no longer exists.");
    return compareRuns(b, c);
  }

  /** Export a run as JSON (with an optional comparison against the baseline). */
  exportRun(id: string): string {
    const run = this.deps.store.get(id);
    if (!run) throw new Error("That run no longer exists.");
    const baselineId = this.deps.store.baselineId();
    const baseline = baselineId && baselineId !== id ? this.deps.store.get(baselineId) : null;
    const comparison = baseline ? compareRuns(baseline, run) : null;
    return JSON.stringify({ kind: "lumen-eval-run", run, comparisonWithBaseline: comparison }, null, 2);
  }
}
