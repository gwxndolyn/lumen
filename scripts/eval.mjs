// Evaluation Lab from the command line (uses the compiled core: run `npm run build:main` first, or
// the npm scripts below, which do it for you).
//
//   npm run eval                                  deterministic, all cases (no network, no key)
//   npm run eval -- --category prompt_injection   one category (repeatable flag)
//   npm run eval -- --case ctx-001 --case fu-002  specific cases
//   npm run eval -- --out run.json                save the full run
//   npm run eval -- --baseline run.json           compare with a saved run; exit 1 on regressions
//   npm run eval:live -- --yes --max-cost 0.50    live: ANTHROPIC_API_KEY must be set; --yes is required
//
// Exit codes: 0 = complete with no failures (and no regressions vs --baseline); 1 = failures,
// regressions, or an incomplete run; 2 = usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = (p) => import(path.join(root, "dist-electron/src", p));

function parseArgs(argv) {
  const a = { mode: "deterministic", categories: [], cases: [], repeat: 1, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) usage(`${k} needs a value`);
      return x;
    };
    if (k === "--live") a.mode = "live";
    else if (k === "--category") a.categories.push(v());
    else if (k === "--case") a.cases.push(v());
    else if (k === "--out") a.out = v();
    else if (k === "--baseline") a.baseline = v();
    else if (k === "--repeat") a.repeat = Number(v());
    else if (k === "--max-cost") a.maxCost = Number(v());
    else if (k === "--concurrency") a.concurrency = Number(v());
    else if (k === "--max-output-tokens") a.maxOut = Number(v());
    else if (k === "--model") a.model = v();
    else if (k === "--prompt") a.prompt = v();
    else if (k === "--budget") a.budget = Number(v());
    else if (k === "--no-verification") a.noVerification = true;
    else if (k === "--yes") a.yes = true;
    else if (k === "--help" || k === "-h") usage();
    else usage(`unknown option ${k}`);
  }
  return a;
}

function usage(msg) {
  if (msg) console.error(`eval: ${msg}`);
  console.error(
    fs
      .readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(0, 13)
      .join("\n"),
  );
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const { BENCHMARK, BENCHMARK_VERSION } = await core("core/eval/benchmark.js");
const { runEvaluation, estimateRunCostUsd } = await core("core/eval/runner.js");
const { compareRuns } = await core("core/eval/compare.js");
const { DEFAULT_SETTINGS } = await core("shared/defaults.js");
const { applySettingsPatch } = await core("shared/settingsSchema.js");

let cases = BENCHMARK;
if (args.categories.length) cases = cases.filter((c) => args.categories.includes(c.category));
if (args.cases.length) cases = cases.filter((c) => args.cases.includes(c.id));
if (!cases.length) usage("no cases match the selection");

let settings = DEFAULT_SETTINGS;
if (args.model) settings = applySettingsPatch(settings, { provider: { model: args.model } });
let liveProvider;
if (args.mode === "live") {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) usage("live mode needs ANTHROPIC_API_KEY in the environment");
  const liveCases = cases.filter((c) => !c.deterministicOnly);
  const est = estimateRunCostUsd(liveCases, settings.provider.model, args.maxOut ?? 1500, args.repeat);
  console.log(`Live run: ${liveCases.length} cases × ${args.repeat} → ${settings.provider.model}. Worst-case estimate ${est.known ? `$${est.usd}` : "unknown"}; limit $${args.maxCost ?? 1}.`);
  if (!args.yes) usage("live mode sends the benchmark prompts to Anthropic and uses API credit; pass --yes to confirm");
  const { AnthropicProvider } = await core("core/providers/anthropic.js");
  liveProvider = () => new AnthropicProvider({ apiKey: key });
}

const started = Date.now();
const run = await runEvaluation({
  mode: args.mode,
  cases,
  benchmarkVersion: BENCHMARK_VERSION,
  settings,
  liveProvider,
  repeat: args.repeat,
  limits: { maxCostUsd: args.maxCost, concurrency: args.concurrency, maxOutputTokens: args.maxOut },
  variant:
    args.prompt || args.budget || args.noVerification ? { name: "cli", promptVersion: args.prompt, contextBudgetChars: args.budget, verification: args.noVerification ? false : undefined } : undefined,
  label: "cli",
});

const c = run.summary.counts;
console.log(`\nLumen eval · benchmark v${run.benchmarkVersion} · ${run.config.mode} · ${run.config.model} · prompt ${run.config.promptVersion} (${run.config.promptHash})`);
console.log(
  `${run.status.toUpperCase()}: ${c.passed} passed, ${c.failed} failed, ${c.inconclusive} inconclusive, ${c.skipped} skipped, ${c.not_run} not run · ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
if (run.stopReason) console.log(`  ${run.stopReason}`);
for (const [m, s] of Object.entries(run.summary.byMetric)) console.log(`  ${m.padEnd(24)} ${s.passed}/${s.total} checks`);
if (run.config.mode === "live") console.log(`  cost ${run.summary.usage.costKnown ? `$${run.summary.usage.costUsd}` : "unknown"} · p50 total ${run.summary.latency.p50TotalMs ?? "—"} ms`);
for (const r of run.results.filter((x) => x.status === "failed" || x.status === "inconclusive")) {
  console.log(`\n✗ ${r.caseId} [${r.status}]${r.reason ? ` ${r.reason}` : ""}`);
  for (const ch of r.checks.filter((x) => !x.passed)) console.log(`    ${ch.describe} — ${ch.detail}`);
}

if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(run, null, 2));
  console.log(`\nSaved ${args.out}`);
}

let regressions = 0;
if (args.baseline) {
  const base = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
  const cmp = compareRuns(base, run);
  console.log(`\nVs baseline ${args.baseline}: ${cmp.counts.improved} improved, ${cmp.counts.regressed} regressed, ${cmp.counts.unchanged} unchanged, ${cmp.counts.inconclusive} inconclusive`);
  for (const w of cmp.warnings) console.log(`  ! ${w}`);
  for (const x of cmp.cases.filter((y) => y.verdict === "regressed" || y.verdict === "improved")) console.log(`  ${x.verdict === "regressed" ? "▼" : "▲"} ${x.caseId}: ${x.reason}`);
  regressions = cmp.counts.regressed;
}

process.exit(run.status === "complete" && c.failed === 0 && regressions === 0 ? 0 : 1);
