// Prettier on files changed relative to the merge base with master (plus uncommitted changes).
// The codebase predates Prettier; formatting only touched files keeps diffs reviewable.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const write = process.argv.includes("--write");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let base = "";
try {
  base = git("merge-base", "HEAD", "master");
} catch {
  base = "HEAD";
}
const files = new Set(
  [...git("diff", "--name-only", base).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(
    (f) => f && existsSync(f) && /^(electron|src|scripts)\/.*\.(ts|tsx|mjs)$/.test(f),
  ),
);
if (!files.size) {
  console.log("format: no changed source files");
  process.exit(0);
}
try {
  execFileSync("npx", ["prettier", write ? "--write" : "--check", ...files], { stdio: "inherit" });
} catch {
  process.exit(1);
}
