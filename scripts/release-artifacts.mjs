// Prepare beta release artifacts from what electron-builder produced in release/. Run after
// `npm run release:gate -- --packaged …` and `npm run package:<platform>` on the same commit.
//
//   npm run release:artifacts                 validate, checksum, write manifest + notes
//   npm run release:artifacts -- --allow-not-ready   write them anyway, marked NOT PUBLISHABLE
//
// What it does (and what it does not):
// 1. Requires release-report.json for this version and commit with a passing verdict; otherwise
//    the manifest is marked not publishable and the script exits 1.
// 2. Validates the packaged app's asar: required entry points are present; source maps, tests,
//    TypeScript sources, .env files, docs and dev-only packages are absent; no file contains a
//    real-looking credential (same patterns as check-secrets).
// 3. Writes SHA-256 checksums (SHA256SUMS) for each installer/archive.
// 4. Writes release/release-manifest.json (version, commit, build time, platform, gate verdict,
//    checks, artifacts, signing status as observed) and release/RELEASE_NOTES.md (CHANGELOG
//    "Unreleased" section + known limitations + verification status).
// It never signs, notarizes, uploads or publishes anything. Signing status is read from the
// artifacts (codesign/spctl on macOS), not assumed.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = path.join(root, "release");
const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const problems = [];
const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse", "HEAD");
const dirty = (git("status", "--porcelain", "--untracked-files=no") ?? "").length > 0;
if (dirty) problems.push("The working tree has uncommitted changes to tracked files: artifacts would not match a commit.");

// ---- 1. gate report ----
let gate = null;
try {
  gate = JSON.parse(fs.readFileSync(path.join(root, "release-report.json"), "utf8"));
} catch {
  problems.push("release-report.json is missing: run `npm run release:gate -- --packaged --baseline <run.json>` first.");
}
if (gate) {
  if (gate.version !== pkg.version) problems.push(`release-report.json is for ${gate.version}, not ${pkg.version}.`);
  if (gate.commit && commit && gate.commit !== commit) problems.push(`release-report.json was produced at ${gate.commit.slice(0, 8)}, not HEAD ${commit.slice(0, 8)}.`);
  if (!gate.commit) problems.push("release-report.json does not record a commit (produced by an older gate); re-run the gate.");
  if (!/^READY/.test(gate.verdict ?? "")) problems.push(`Release gate verdict is "${gate.verdict}".`);
  const packaged = gate.checks?.find((c) => c.id === "packaged");
  if (packaged?.status !== "passed") problems.push(`Packaged-app smoke ${packaged ? packaged.status : "missing"}${packaged?.reason ? ` (${packaged.reason})` : ""}: run the gate with --packaged.`);
}

// ---- 2. artifacts and package contents ----
if (!fs.existsSync(rel)) {
  console.error("release/ does not exist: run `npm run package:mac` / `package:win` first.");
  process.exit(1);
}
const INSTALLER = /\.(dmg|zip|exe|AppImage|deb|rpm)$/;
const artifacts = fs
  .readdirSync(rel)
  .filter((f) => INSTALLER.test(f) && f.includes(pkg.version))
  .sort();
if (!artifacts.length) problems.push(`No installers for ${pkg.version} in release/.`);
const stale = fs.readdirSync(rel).filter((f) => INSTALLER.test(f) && !f.includes(pkg.version));
if (stale.length) problems.push(`release/ also contains artifacts from other versions (${stale.join(", ")}); remove them so they are not published by mistake.`);

const asars = [];
for (const d of fs.readdirSync(rel)) {
  for (const p of [path.join(rel, d, "Lumen.app/Contents/Resources/app.asar"), path.join(rel, d, "resources/app.asar")]) if (fs.existsSync(p)) asars.push(p);
}
if (!asars.length) problems.push("No unpacked app (release/*/…/app.asar) to inspect: build with electron-builder (the --dir output is kept alongside installers).");

const SECRET = [
  ["Anthropic key", /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{64,}/],
];
const placeholder = (m) => /ABCDEFGHIJ|abcdefghij|(.)\1{11,}|test|fake|example|smoke/i.test(m);
const REQUIRED = ["/package.json", "/dist-electron/electron/main.js", "/dist-electron/electron/preload.js", "/dist-renderer/index.html"];
const FORBIDDEN = [
  [/\.map$/, "source map"],
  [/\.(ts|tsx)$/, "TypeScript source"],
  [/(^|\/)\.env(\.|$)/, ".env file"],
  // Lumen's own source tree (library folders named src/ inside node_modules are their runtime code).
  [/^\/(src|scripts|docs|\.github)\//, "repository source folder"],
  [/\/node_modules\/(vitest|vite|typescript|electron-builder|oxlint|prettier|@testing-library|jsdom)\//, "development dependency"],
  [/\/(test|tests|__tests__)\//, "test folder"],
  [/\/(release-report|release-benchmark|regression-cases)\.json$/, "release or evaluation data"],
  [/\/lumen\.(db|log)/, "user data"],
];
const asarInfo = [];
if (asars.length) {
  const asar = await import(path.join(root, "node_modules/@electron/asar/lib/asar.js")).catch(() => null);
  if (!asar) problems.push("@electron/asar is not installed; cannot inspect the package.");
  for (const a of asar ? asars : []) {
    const files = asar.listPackage(a, { isPack: false });
    const bad = [];
    for (const f of files) for (const [re, why] of FORBIDDEN) if (re.test(f)) bad.push(`${f} (${why})`);
    for (const r of REQUIRED) if (!files.includes(r)) problems.push(`${path.relative(rel, a)}: missing ${r}`);
    let scanned = 0;
    const secretHits = [];
    for (const f of files) {
      if (!/\.(js|json|html|css|txt|cjs|mjs)$/.test(f)) continue;
      let text;
      try {
        text = asar.extractFile(a, f.slice(1)).toString("utf8");
      } catch {
        continue; // directory entry or unpacked file
      }
      scanned++;
      for (const [name, re] of SECRET) for (const m of text.matchAll(new RegExp(re.source, "g"))) if (!placeholder(m[0])) secretHits.push(`${f}: ${name}`);
    }
    if (bad.length) problems.push(`${path.relative(rel, a)} contains files that must not ship:\n    ${bad.slice(0, 20).join("\n    ")}${bad.length > 20 ? `\n    … ${bad.length - 20} more` : ""}`);
    if (secretHits.length) problems.push(`${path.relative(rel, a)} contains possible credentials:\n    ${secretHits.join("\n    ")}`);
    asarInfo.push({ path: path.relative(rel, a), files: files.length, scannedForSecrets: scanned, forbidden: bad.length, secrets: secretHits.length });
  }
}

// An installer older than the app it should contain was built from different code.
const newestApp = Math.max(0, ...asars.map((a) => fs.statSync(a).mtimeMs));
const staleInstallers = artifacts.filter((f) => fs.statSync(path.join(rel, f)).mtimeMs + 60_000 < newestApp);
if (staleInstallers.length) problems.push(`Installers older than the packaged app (rebuild with npm run package:<platform>): ${staleInstallers.join(", ")}`);

// ---- 3. checksums and signing status (observed, never assumed) ----
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const list = artifacts.map((f) => {
  const full = path.join(rel, f);
  return { file: f, bytes: fs.statSync(full).size, sha256: sha(full) };
});
const signing = [];
for (const a of asars) {
  const app = a.includes("Lumen.app") ? a.slice(0, a.indexOf("Lumen.app") + "Lumen.app".length) : null;
  if (!app || process.platform !== "darwin") {
    signing.push({ target: path.relative(rel, path.dirname(a)), status: "not_checked", reason: "signature checks for this platform must run on that platform" });
    continue;
  }
  const cs = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  const sp = spawnSync("spctl", ["--assess", "--type", "execute", app], { encoding: "utf8" });
  signing.push({
    target: path.relative(rel, app),
    status: cs.status === 0 && sp.status === 0 ? "signed_and_accepted" : cs.status === 0 ? "signed_not_notarized_or_rejected" : "unsigned",
    detail: `${(cs.stderr || cs.stdout).trim().split("\n")[0] ?? ""} | ${(sp.stderr || sp.stdout).trim().split("\n")[0] ?? ""}`.slice(0, 300),
  });
}
const signed = signing.length > 0 && signing.every((s) => s.status === "signed_and_accepted");

// ---- 4. manifest and notes ----
const publishable = problems.length === 0 && signed;
const blockers = [...problems, ...(signed ? [] : ["Artifacts are not signed and notarized (see signing): fine for a hand-distributed internal beta, not for public download."])];
const manifest = {
  kind: "lumen-release-manifest",
  version: pkg.version,
  commit,
  dirty,
  builtAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  gate: gate ? { verdict: gate.verdict, generatedAt: gate.generatedAt, checks: (gate.checks ?? []).map((c) => ({ id: c.id, status: c.status, counts: c.counts ?? null })) } : null,
  artifacts: list,
  packageContents: asarInfo,
  signing,
  publishable,
  blockers,
  notChecked: [
    "Installers on the other operating system (build and run this script there).",
    "Install / upgrade / uninstall by hand (docs/BETA.md §9 step 4).",
    "Automatic updates: Lumen only checks a feed and opens the download page; there is no in-app updater to verify.",
    "Rollback: users reinstall the previous installer from the release page; the database refuses to open with an older Lumen than the one that migrated it (schema check), so rollback after a schema migration needs the pre-migration backup (lumen.db.backup-v<N>).",
  ],
};
fs.writeFileSync(path.join(rel, "release-manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(rel, "SHA256SUMS"), list.map((a) => `${a.sha256}  ${a.file}`).join("\n") + (list.length ? "\n" : ""));

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const unreleased = /## Unreleased[^\n]*\n([\s\S]*?)(?=\n## |\s*$)/.exec(changelog)?.[1]?.trim() ?? "(no Unreleased section in CHANGELOG.md)";
const notes = `# Lumen ${pkg.version} — beta

Built ${manifest.builtAt} from ${commit ? commit.slice(0, 12) : "an unknown commit"}${dirty ? " (with uncommitted changes)" : ""}.
Release gate: ${gate?.verdict ?? "not run"}.

## Changes

${unreleased}

## Downloads

| File | Size | SHA-256 |
|---|---|---|
${list.map((a) => `| ${a.file} | ${(a.bytes / 1e6).toFixed(1)} MB | \`${a.sha256}\` |`).join("\n") || "| (none) | | |"}

Verify a download with \`shasum -a 256 <file>\` (macOS) or \`Get-FileHash <file>\` (Windows) and compare with SHA256SUMS.

## Signing

${signing.map((s) => `- ${s.target}: ${s.status.replace(/_/g, " ")}${s.reason ? ` (${s.reason})` : ""}`).join("\n") || "- not checked"}
${signed ? "" : "\nThese builds are **not signed and notarized**. macOS Gatekeeper and Windows SmartScreen will warn on first launch. Distribute only to invited beta testers, with the instructions in docs/BETA.md."}

## Known limitations

${(gate?.limitations ?? []).map((l) => `- ${l}`).join("\n") || "- see docs/BETA.md §10"}
${manifest.notChecked.map((l) => `- Not verified by this build: ${l}`).join("\n")}

## Feedback

Use **Send feedback** in Lumen (or "Report" under an answer), preview the file, save it, and send it to the beta contact you were invited by. Nothing is uploaded automatically.
`;
fs.writeFileSync(path.join(rel, "RELEASE_NOTES.md"), notes);

console.log(`Lumen ${pkg.version} artifacts (${commit?.slice(0, 8) ?? "?"})`);
for (const a of list) console.log(`  ${a.sha256.slice(0, 16)}…  ${a.file}`);
for (const p of asarInfo) console.log(`  package ${p.path}: ${p.files} files, ${p.scannedForSecrets} scanned, ${p.forbidden} forbidden, ${p.secrets} secrets`);
for (const s of signing) console.log(`  signing ${s.target}: ${s.status}`);
for (const b of blockers) console.log(`  ✗ ${b}`);
console.log(`  ${publishable ? "PUBLISHABLE" : "NOT PUBLISHABLE"} — release/release-manifest.json, release/SHA256SUMS, release/RELEASE_NOTES.md`);
// Package-content and gate problems always fail; unsigned builds fail unless explicitly allowed (internal beta).
process.exit(problems.length && !args.includes("--allow-not-ready") ? 1 : 0);
