// Controlled experiments: the same cases and criteria, run once per variant, then each variant
// compared with the first (the control). Variants are a closed set of explicit settings — no
// prompt generation, no search — and live experiments share one cost limit across all variants.

import { randomUUID } from "node:crypto";
import { compareRuns, type RunComparison } from "./compare";
import { PROMPT_VERSIONS } from "./prompts";
import { runEvaluation, type RunOptions } from "./runner";
import type { EvalRun, Variant } from "./types";

export interface ExperimentDef {
  name: string;
  variants: Variant[];
}

export interface ExperimentResult {
  id: string;
  name: string;
  runs: EvalRun[];
  /** Variant i (i ≥ 1) against the control (variant 0). */
  comparisons: RunComparison[];
}

/** Ready-made experiments shown in the Lab. */
export const PRESET_EXPERIMENTS: ExperimentDef[] = [
  { name: "Verification on vs off", variants: [{ name: "verification on" }, { name: "verification off", verification: false }] },
  { name: "Context budget 60k vs 8k", variants: [{ name: "60k chars" }, { name: "8k chars", contextBudgetChars: 8000 }] },
  { name: "Production vs minimal prompt", variants: [{ name: "production" }, { name: "minimal", promptVersion: "minimal" }] },
];

export function validateExperiment(def: ExperimentDef) {
  if (def.variants.length < 2 || def.variants.length > 4) throw new Error("An experiment needs 2–4 variants.");
  for (const v of def.variants) {
    if (v.promptVersion && !PROMPT_VERSIONS.some((p) => p.id === v.promptVersion)) throw new Error(`Unknown prompt version "${v.promptVersion}".`);
    if (v.contextBudgetChars !== undefined && (v.contextBudgetChars < 1000 || v.contextBudgetChars > 200_000)) throw new Error("Context budget must be between 1,000 and 200,000 characters.");
  }
}

export async function runExperiment(def: ExperimentDef, base: Omit<RunOptions, "variant" | "experiment">): Promise<ExperimentResult> {
  validateExperiment(def);
  const id = randomUUID();
  const runs: EvalRun[] = [];
  // One cost limit for the whole experiment: each variant gets what the earlier ones left.
  let remaining = base.limits?.maxCostUsd;
  for (const v of def.variants) {
    if (base.signal?.aborted) break;
    // The runner stops at the remaining limit and marks the run partial.
    const run = await runEvaluation({ ...base, variant: v, limits: { ...base.limits, maxCostUsd: remaining }, label: `${def.name} · ${v.name}`, experiment: { id, name: def.name, variant: v.name } });
    runs.push(run);
    if (remaining !== undefined) remaining = Math.max(0, remaining - run.summary.usage.costUsd);
  }
  const comparisons = runs.slice(1).map((r) => compareRuns(runs[0]!, r));
  return { id, name: def.name, runs, comparisons };
}
