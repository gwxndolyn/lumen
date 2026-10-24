// Evaluation Lab from the command line (uses the compiled core: run `npm run build:main` first, or
// the npm scripts below, which do it for you).
//
//   npm run eval                                  deterministic, all cases (no network, no key)
//   npm run eval -- --category prompt_injection   one category (repeatable flag)
//   npm run eval -- --case ctx-001 --case fu-002  specific cases
//   npm run eval -- --out run.json                save the full run
//   npm run eval -- --baseline run.json           compare with a saved run; exit 1 on regressions
//   npm run eval -- --collection benchmark        shipped benchmark only (default "all" adds approved beta regression cases)
//   npm run eval:live -- --yes --max-cost 0.50    live: ANTHROPIC_API_KEY must be set; --yes is required
//   npm run eval:live -- --local llama3.2 --yes   live against a local Ollama model (nothing leaves the device)
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
    else if (k === "--local") a.local = v();
    else if (k === "--ollama-url") a.ollamaUrl = v();
    else if (k === "--prompt") a.prompt = v();
    else if (k === "--budget") a.budget = Number(v());
    else if (k === "--no-verification") a.noVerification = true;
    else if (k === "--yes") a.yes = true;
    else if (k === "--collection") a.collection = v();
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
      .slice(0, 14)
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

// Approved beta regression cases (src/core/eval/regression-cases.json). Proposed, edited-since-
// approval and invalid entries are never run; an invalid file fails the run.
const { loadRegressions } = await core("core/beta/regressions.js");
const regFile = path.join(root, "src/core/eval/regression-cases.json");
const reg = loadRegressions(fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, "utf8")) : null);
const collection = args.collection ?? "all";
if (!["all", "benchmark", "regressions"].includes(collection)) usage("--collection must be all, benchmark or regressions");
if (reg.invalid.length) {
  console.error(`Regression case file has problems:\n  ${reg.invalid.join("\n  ")}`);
  process.exit(1);
}
let cases = collection === "benchmark" ? BENCHMARK : collection === "regressions" ? reg.trusted : [...BENCHMARK, ...reg.trusted];
if (collection !== "benchmark")
  console.log(
    `Beta regression cases: ${reg.trusted.length} approved${reg.proposed.length ? `, ${reg.proposed.length} awaiting review (not run: ${reg.proposed.join(", ")})` : ""}${reg.stale.length ? `, ${reg.stale.length} edited since approval (not run until re-approved: ${reg.stale.join(", ")})` : ""}`,
  );
if (args.categories.length) cases = cases.filter((c) => args.categories.includes(c.category));
if (args.cases.length) cases = cases.filter((c) => args.cases.includes(c.id));
if (!cases.length && collection === "regressions" && !args.categories.length && !args.cases.length) {
  console.log("No approved beta regression cases yet: nothing to run.");
  process.exit(0);
}
if (!cases.length) usage("no cases match the selection");

let settings = DEFAULT_SETTINGS;
if (args.model) settings = applySettingsPatch(settings, { provider: { model: args.model } });
let liveProvider;
let describeLocal;
if (args.mode === "live" && args.local) {
  const { OllamaRuntime, OllamaProvider } = await core("core/providers/ollama.js");
  const url = args.ollamaUrl ?? "http://127.0.0.1:11434";
  const rt = new OllamaRuntime(url);
  const st = await rt.status();
  if (!st.available) usage(`local runtime not available: ${st.error}`);
  const details = await rt.show(args.local).catch(() => usage(`"${args.local}" is not installed. Install it yourself with: ollama pull ${args.local}`));
  settings = applySettingsPatch(settings, { provider: { kind: "ollama" }, inference: { local: { baseUrl: url, model: args.local } } });
  console.log(`Local run: ${cases.filter((c) => !c.deterministicOnly).length} cases × ${args.repeat} → ${args.local} on Ollama ${st.version} (${url}). No data leaves this computer.`);
  if (!args.yes) usage("pass --yes to start the local run");
  liveProvider = () => new OllamaProvider({ baseUrl: url, model: args.local, numCtx: settings.inference.local.numCtx, details });
  describeLocal = async () => ({ runtimeVersion: st.version, loaded: await rt.loaded().catch(() => []) });
} else if (args.mode === "live") {
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
  describeLocal,
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
if (run.environment && run.config.mode === "live")
  console.log(
    `  environment: ${run.environment.os} · ${run.environment.cpu} ×${run.environment.cpuCount} · ${run.environment.memoryGb} GB RAM${run.environment.loadedModels?.length ? ` · loaded ${run.environment.loadedModels.map((m) => `${m.name} ${(m.sizeBytes / 1e9).toFixed(1)} GB`).join(", ")}` : ""}`,
  );
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
