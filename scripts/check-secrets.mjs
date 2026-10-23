// Fails if a tracked or about-to-be-committed file contains something that looks like a real API
// key. Test fixtures use obviously fake keys (e.g. "sk-ant-test-…"), which are allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Anthropic key", /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  // A real PEM body is base64 and long; redaction tests use a placeholder body.
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{64,}/],
  ["Deepgram-style token assignment", /DEEPGRAM_API_KEY\s*=\s*["']?[a-f0-9]{40}\b/],
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/(^|\/)(node_modules|release|dist-electron|dist-renderer)\//.test(f) && !/\.(png|jpe?g|gif|ico|icns|traineddata|gz|wasm)$/.test(f) && f !== "package-lock.json");

/** Obvious test placeholders: alphabet runs, repeated characters, or an explicit "test" marker. */
const isPlaceholder = (m) => /ABCDEFGHIJ|abcdefghij|(.)\1{11,}|test|fake|example/i.test(m);

const hits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  for (const [name, re] of PATTERNS) {
    const g = new RegExp(re.source, "g");
    for (const m of text.matchAll(g)) if (!isPlaceholder(m[0])) hits.push(`${f}: ${name}`);
  }
}
if (hits.length) {
  console.error(`Possible secrets found (${hits.length}):\n${hits.map((h) => `  ${h}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-secrets: ${files.length} files scanned, no secrets found`);
