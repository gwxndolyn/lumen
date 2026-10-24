// Deterministic syntax checks for code blocks in an answer. Nothing is executed: JavaScript is
// compiled with vm.Script (parse only — the script is never run), TypeScript has its types stripped
// by Node (no type checking), JSON is parsed. Every other language is reported "unavailable", never
// as passed. Results describe exactly what was checked so the UI can't overstate them.

import vm from "node:vm";
import * as nodeModule from "node:module";

export type CheckStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface CodeCheck {
  /** Index of the fenced block in the answer (0-based). */
  block: number;
  lang: string;
  status: CheckStatus;
  /** What was actually done, in words ("JavaScript syntax parsed (not run)"). */
  method: string;
  /** Parser message on failure, or why the check could not run. */
  detail: string | null;
}

const MAX_BLOCK_CHARS = 50_000;
const MAX_BLOCKS = 8;

const JS = new Set(["js", "javascript", "jsx", "mjs", "cjs", "node"]);
const TS = new Set(["ts", "typescript", "tsx", "mts", "cts"]);
const JSON_LANGS = new Set(["json", "jsonc"]);

/** Node ≥ 22.13 / 23.2 ships type stripping; older runtimes report TypeScript as unavailable. */
const stripTypes = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, opts?: { mode?: string }) => string }).stripTypeScriptTypes;

/** Fragments ("…", "// rest unchanged") and shell transcripts are not standalone programs. */
function isFragment(body: string): boolean {
  return /^\s*(\.\.\.|…)\s*$/m.test(body) || /\/\/\s*\.\.\.|\/\*\s*\.\.\.\s*\*\/|\/\/\s*(rest|existing|unchanged)/i.test(body);
}

/**
 * Compile only. vm.Script never executes code (runInContext is never called). Module syntax and
 * top-level await aren't valid in a classic script, so a module-looking block has its import
 * statements removed and `export` keywords dropped, then is wrapped in an async function body.
 */
function compiles(code: string): string | null {
  try {
    // Compiling is the check; the script object is discarded unrun.
    const compiled = new vm.Script(code, { filename: "answer.js" });
    return compiled ? null : "could not compile";
  } catch (e) {
    return e instanceof SyntaxError ? e.message : null;
  }
}

function checkJs(body: string): { status: CheckStatus; detail: string | null } {
  const isModule = /^\s*(import|export)\s/m.test(body) || /^\s*(const|let|var)?[^\n]*\bawait\b/m.test(body);
  const src = isModule
    ? `(async () => {\n${body
        .replace(/^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["'][^"']+["'];?\s*$/gm, "")
        .replace(/^\s*export\s+default\s+/gm, "const __default = ")
        .replace(/^\s*export\s+(?=(const|let|var|function|class|async)\b)/gm, "")
        .replace(/^\s*export\s*\{[^}]*\}\s*(from\s+["'][^"']+["'])?;?\s*$/gm, "")}\n})`
    : body;
  const err = compiles(src);
  return err ? { status: "failed", detail: err } : { status: "passed", detail: null };
}

function checkTs(body: string, lang: string): { status: CheckStatus; detail: string | null; method: string } {
  if (!stripTypes) return { status: "unavailable", detail: "This runtime has no TypeScript parser.", method: "TypeScript check unavailable" };
  if (lang === "tsx") return { status: "unavailable", detail: "TSX/JSX is not parsed.", method: "TSX not checked" };
  let js: string;
  try {
    // Suppress Node's one-time ExperimentalWarning for this call only.
    const emit = process.emitWarning;
    process.emitWarning = () => undefined;
    try {
      js = stripTypes(body, { mode: "strip" });
    } finally {
      process.emitWarning = emit;
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    // enums/namespaces/parameter properties need transformation, not a syntax error.
    if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
      return { status: "unavailable", detail: "Uses TypeScript features (e.g. enum) that type stripping can't check.", method: "TypeScript check unavailable" };
    return { status: "failed", detail: (e as Error).message.split("\n")[0]!.slice(0, 200), method: "TypeScript syntax parsed (types not checked, not run)" };
  }
  const r = checkJs(js);
  return { ...r, method: "TypeScript syntax parsed (types not checked, not run)" };
}

export function checkCodeBlocks(answer: string): CodeCheck[] {
  const blocks = [...answer.matchAll(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g)].slice(0, MAX_BLOCKS);
  return blocks.map((m, block) => {
    const lang = (m[1] ?? "").toLowerCase();
    const body = m[2] ?? "";
    const base = { block, lang: lang || "untagged" };
    if (!body.trim()) return { ...base, status: "skipped" as const, method: "Empty block", detail: null };
    if (body.length > MAX_BLOCK_CHARS) return { ...base, status: "skipped" as const, method: "Too large to check", detail: null };
    if (JSON_LANGS.has(lang)) {
      if (lang === "jsonc" || /^\s*\/\//m.test(body)) return { ...base, status: "unavailable" as const, method: "JSON with comments not checked", detail: null };
      try {
        JSON.parse(body);
        return { ...base, status: "passed" as const, method: "JSON parsed", detail: null };
      } catch (e) {
        return { ...base, status: "failed" as const, method: "JSON parsed", detail: (e as Error).message.slice(0, 200) };
      }
    }
    if (JS.has(lang) || TS.has(lang)) {
      if (isFragment(body)) return { ...base, status: "skipped" as const, method: "Partial snippet (contains “…” placeholders); not checked", detail: null };
      if (/<[A-Z][\w.]*[\s/>]|<\/[a-z]+>/.test(body) && (lang === "jsx" || lang === "js" || lang === "javascript"))
        return { ...base, status: "unavailable" as const, method: "JSX not checked", detail: "JSX needs a compiler that Lumen does not include." };
      if (TS.has(lang)) return { ...base, ...checkTs(body, lang) };
      return { ...base, ...checkJs(body), method: "JavaScript syntax parsed (not run)" };
    }
    return { ...base, status: "unavailable" as const, method: `No ${lang || "untagged"} checker in Lumen`, detail: null };
  });
}

/** One-line summary for the answer footer, e.g. "Syntax: 2 passed, 1 unavailable". */
export function summarizeCodeChecks(checks: CodeCheck[]): string | null {
  if (!checks.length) return null;
  const n = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const parts = (["failed", "passed", "unavailable", "skipped"] as const).filter((s) => n(s)).map((s) => `${n(s)} ${s}`);
  return `Code syntax: ${parts.join(", ")} (not run)`;
}
