// Release-quality gate. Runs each check, records what actually happened, and writes
// release-report.json + a summary. A check that could not run is "skipped" (with the reason) and
// a skipped critical check makes the verdict NOT READY — never "passed".
//
//   npm run release:gate                         all checks that can run here
//   npm run release:gate -- --baseline run.json  also compare the benchmark with a recorded run
//   npm run release:gate -- --skip smoke         skip a check (recorded as skipped)
//   npm run release:gate -- --packaged           also build the packaged app and smoke-test it
//
// Exit codes: 0 = all critical checks passed (verdict says beta vs release candidate), 1 = NOT READY.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const skip = new Set(args.flatMap((a, i) => (args[i - 1] === "--skip" ? [a] : [])));
const baseline = opt("--baseline");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-gate-"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** id, label, critical, command, how to read the result. */
const CHECKS = [
  { id: "typecheck", label: "Type check", critical: true, cmd: ["npm", "run", "-s", "typecheck"] },
  { id: "lint", label: "Lint", critical: true, cmd: ["npm", "run", "-s", "lint"] },
  { id: "tests", label: "Unit and integration tests", critical: true, cmd: ["npx", "vitest", "run", "--reporter=json", `--outputFile=${path.join(tmp, "tests.json")}`] },
  { id: "secrets", label: "Secret scan", critical: true, cmd: ["npm", "run", "-s", "check:secrets"] },
  { id: "audit", label: "Dependency audit (shipped code)", critical: true, cmd: ["npm", "run", "-s", "audit:prod"] },
  { id: "build", label: "Build", critical: true, cmd: ["npm", "run", "-s", "build"] },
  {
    id: "benchmark",
    label: "Deterministic intelligence benchmark",
    critical: true,
    cmd: ["node", "scripts/eval.mjs", "--out", path.join(tmp, "bench.json"), ...(baseline ? ["--baseline", baseline] : [])],
  },
  {
    id: "regressions",
    label: "Beta regression cases (approved)",
    critical: true,
    cmd: ["node", "scripts/eval.mjs", "--collection", "regressions"],
    // An empty approved collection is a pass with a note, not a skip: there is nothing to regress.
  },
  {
    id: "beta-blockers",
    label: "Open security/privacy and data-loss beta issues",
    critical: true,
    cmd: ["node", "scripts/triage.mjs", "blockers"],
    needsEnv: ["LUMEN_TRIAGE_DIR"],
  },
  { id: "smoke", label: "End-to-end smoke (Electron)", critical: true, cmd: ["bash", "scripts/smoke.sh"], needsDisplay: true },
  { id: "restart", label: "Restart persistence (two launches)", critical: true, cmd: ["bash", "scripts/smoke-restart.sh"], needsDisplay: true },
  { id: "upgrade", label: "Upgrade from an older schema", critical: true, cmd: ["bash", "scripts/smoke-upgrade.sh"], needsDisplay: true },
  {
    id: "packaged",
    label: "Packaged app smoke",
    critical: false,
    cmd: ["bash", "-c", "npx electron-builder --dir --publish never > /dev/null && bash scripts/smoke-packaged.sh"],
    needsDisplay: true,
    optIn: "--packaged",
  },
  { id: "live", label: "Live provider tests", critical: false, cmd: ["npm", "run", "-s", "test:live"], needsEnv: ["ANTHROPIC_API_KEY"] },
];

const results = [];
for (const c of CHECKS) {
  const started = Date.now();
  if (c.optIn && !args.includes(c.optIn)) {
    results.push({ id: c.id, label: c.label, critical: c.critical, status: "skipped", reason: `pass ${c.optIn} to run (slow: builds the app)`, ms: 0 });
    continue;
  }
  if (skip.has(c.id)) {
    results.push({ id: c.id, label: c.label, critical: c.critical, status: "skipped", reason: "skipped with --skip", ms: 0 });
    continue;
  }
  const missing = (c.needsEnv ?? []).filter((k) => !process.env[k]);
  if (missing.length) {
    results.push({ id: c.id, label: c.label, critical: c.critical, status: "skipped", reason: `needs ${missing.join(", ")}`, ms: 0 });
    continue;
  }
  if (c.needsDisplay && process.platform === "linux" && !process.env.DISPLAY) {
    results.push({ id: c.id, label: c.label, critical: c.critical, status: "skipped", reason: "no display available", ms: 0 });
    continue;
  }
  process.stdout.write(`• ${c.label} … `);
  const r = spawnSync(c.cmd[0], c.cmd.slice(1), { cwd: root, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const entry = { id: c.id, label: c.label, critical: c.critical, status: r.status === 0 ? "passed" : "failed", ms: Date.now() - started, tail: out.trim().split("\n").slice(-12).join("\n") };
  if (c.id === "tests") {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(tmp, "tests.json"), "utf8"));
      entry.counts = { passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests + (j.numTodoTests ?? 0) };
    } catch {
      /* counts unavailable */
    }
  }
  if (c.id === "benchmark") {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(tmp, "bench.json"), "utf8"));
      entry.counts = run.summary.counts;
      entry.runStatus = run.status;
      entry.latencyP50Ms = run.summary.latency.p50TotalMs;
      const m = /Vs baseline [^:]+: (\d+) improved, (\d+) regressed, (\d+) unchanged, (\d+) inconclusive/.exec(out);
      if (m) entry.baseline = { improved: +m[1], regressed: +m[2], unchanged: +m[3], inconclusive: +m[4] };
      fs.copyFileSync(path.join(tmp, "bench.json"), path.join(root, "release-benchmark.json"));
    } catch {
      /* no run file */
    }
  }
  results.push(entry);
  console.log(entry.status.toUpperCase(), `(${(entry.ms / 1000).toFixed(1)} s)`);
}

const criticalNotPassed = results.filter((r) => r.critical && r.status !== "passed");
const ready = criticalNotPassed.length === 0;
// Production additionally needs real-provider verification; signing is never checked here.
const liveVerified = results.find((r) => r.id === "live")?.status === "passed";
const limitations = [
  `Platform: checks ran on ${os.type()} ${os.release()} ${os.arch()}; other platforms are covered only by CI.`,
  "Code signing and notarization are not checked here.",
  results.find((r) => r.id === "live")?.status !== "passed" ? "Live provider behaviour was not verified (no API key)." : null,
  !baseline ? "No --baseline given: the benchmark was not compared with a recorded run." : null,
  results.find((r) => r.id === "beta-blockers")?.status === "skipped" ? "Beta triage was not checked (set LUMEN_TRIAGE_DIR to the team's triage workspace)." : null,
].filter(Boolean);
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}
const report = {
  kind: "lumen-release-report",
  version: pkg.version,
  commit,
  generatedAt: new Date().toISOString(),
  platform: { os: os.type(), release: os.release(), arch: os.arch(), node: process.version },
  verdict: !ready ? "NOT READY" : liveVerified ? "READY FOR RELEASE CANDIDATE (signing not checked)" : "READY FOR BETA (not production: live providers unverified)",
  blocking: criticalNotPassed.map((r) => `${r.label}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`),
  checks: results,
  limitations,
};
fs.writeFileSync(path.join(root, "release-report.json"), JSON.stringify(report, null, 2));
console.log(`\nLumen ${pkg.version} release gate: ${report.verdict}`);
for (const r of results)
  console.log(
    `  ${r.status.padEnd(8)} ${r.critical ? "*" : " "} ${r.label}${r.counts ? ` ${JSON.stringify(r.counts)}` : ""}${r.baseline ? ` vs baseline ${JSON.stringify(r.baseline)}` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
  );
for (const b of report.blocking) console.log(`  ✗ blocking: ${b}`);
for (const l of limitations) console.log(`  ! ${l}`);
console.log("  (* = critical)  Report: release-report.json");
process.exit(ready ? 0 : 1);
