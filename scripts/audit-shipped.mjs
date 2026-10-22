// npm audit for production deps, minus advisories in modules electron-builder excludes from the
// shipped app. An exclusion only counts if the packaged asar (when present) really lacks the module.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** Modules excluded in electron-builder.yml, with the reason they are safe to omit. */
const EXCLUDED = {
  argparse: "only used by mammoth's CLI (bin/mammoth), which Lumen never runs",
  "sprintf-js": "only reachable through argparse",
};

let report;
try {
  report = JSON.parse(execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" }));
} catch (err) {
  report = JSON.parse(err.stdout); // npm audit exits non-zero when advisories exist
}
const vulns = Object.entries(report.vulnerabilities ?? {});
const config = readFileSync("electron-builder.yml", "utf8");
const asar = ["release/mac-arm64/Lumen.app/Contents/Resources/app.asar", "release/win-unpacked/resources/app.asar"].find(existsSync);
const shipped = asar ? execFileSync("npx", ["--yes", "@electron/asar", "list", asar], { encoding: "utf8" }) : null;

const byName = Object.fromEntries(vulns);
/** Exact `- "!…"` exclusion entries from electron-builder.yml. */
const excludePatterns = [...config.matchAll(/^\s*-\s*"!([^"]+)"/gm)].map((m) => m[1]);
/** Advisory sits in a module we exclude from the build, and the packaged app really lacks it. */
const excludedAndAbsent = (name) =>
  !!EXCLUDED[name] &&
  excludePatterns.some((pat) => pat === `node_modules/${name}/**` || pat.endsWith(`/node_modules/${name}/**`)) &&
  (shipped === null || !new RegExp(`node_modules/(.+/)?${name.replace(/[.-]/g, "\\$&")}/`).test(shipped));
/** Accepted if excluded itself, or if it is only flagged through dependencies that are all accepted. */
const accepted = (name, seen = new Set()) => {
  if (excludedAndAbsent(name)) return true;
  const v = byName[name];
  if (!v || seen.has(name)) return false;
  seen.add(name);
  const via = v.via ?? [];
  return via.length > 0 && via.every((x) => typeof x === "string" && accepted(x, seen));
};

const blocking = [];
for (const [name, v] of vulns) {
  if (accepted(name)) console.log(`accepted  ${name} (${v.severity}): ${EXCLUDED[name] ?? "only flagged through excluded dependencies"}`);
  else blocking.push(`${name} (${v.severity})`);
}
if (shipped === null) console.log("note: no packaged build found; exclusions checked against electron-builder.yml only");
if (blocking.length) {
  console.error(`audit: ${blocking.length} advisories affect shipped code: ${blocking.join(", ")}`);
  process.exit(1);
}
console.log(`audit: ${vulns.length} advisories, none in shipped code`);
