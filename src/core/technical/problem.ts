// Deterministic pre-analysis of a programming problem statement (pasted text or OCR output).
// It does not solve anything: it structures what is actually present so the model is grounded,
// and reports what is missing so Lumen can ask for it instead of guessing.

export type Language = "python" | "java" | "javascript" | "typescript" | "cpp" | "sql" | "go" | "csharp" | "kotlin" | "rust";

export const LANGUAGES: { id: Language; label: string; fence: string }[] = [
  { id: "python", label: "Python", fence: "python" },
  { id: "java", label: "Java", fence: "java" },
  { id: "javascript", label: "JavaScript", fence: "javascript" },
  { id: "typescript", label: "TypeScript", fence: "typescript" },
  { id: "cpp", label: "C++", fence: "cpp" },
  { id: "sql", label: "SQL", fence: "sql" },
  { id: "go", label: "Go", fence: "go" },
  { id: "csharp", label: "C#", fence: "csharp" },
  { id: "kotlin", label: "Kotlin", fence: "kotlin" },
  { id: "rust", label: "Rust", fence: "rust" },
];

export interface ProblemExample {
  input: string;
  output: string;
  explanation: string | null;
}

export interface ParsedProblem {
  title: string | null;
  statement: string;
  inputFormat: string | null;
  outputFormat: string | null;
  constraints: string[];
  examples: ProblemExample[];
  /** Function or class signature found in a code stub, if any. */
  signature: string | null;
  starterCode: string | null;
  detectedLanguage: Language | null;
  kind: "algorithm" | "sql" | "system_design" | "debugging" | "concept";
  /** Hints derived from the constraints (e.g. n ≤ 1e5 → O(n log n) needed). Labelled as inference. */
  complexityHint: string | null;
  missing: string[];
  /** True when the text looks cut off (OCR of a partial screenshot). */
  looksTruncated: boolean;
}

const HEADINGS = {
  input: /^\s*(input( format)?|parameters?|arguments?)\s*:?\s*$/i,
  output: /^\s*(output( format)?|returns?|return value)\s*:?\s*$/i,
  constraints: /^\s*(constraints?|limits?|note)\s*:?\s*$/i,
  example: /^\s*(example|sample)(\s*(input|test case))?\s*#?\s*\d*\s*:?\s*$/i,
};

/** Normalize common OCR damage in math/notation without inventing content. */
export function normalizeNotation(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[−–—]/g, "-")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/×/g, "*")
    .replace(/(\d)\s*\^\s*(\d+)/g, "$1^$2")
    .replace(/10(\d)(?=\s|$|[,.)])/g, (m, d: string) => (/^[5-9]$/.test(d) ? `10^${d}` : m)) // OCR drops the caret: "105" in "n <= 105"
    .replace(/[ \t]+$/gm, "");
}

export function detectLanguage(code: string): Language | null {
  const c = code;
  if (/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE TABLE)\b/im.test(c) && /\bFROM\b/i.test(c)) return "sql";
  if (/\bdef \w+\(.*\)\s*(->\s*[\w[\], ]+)?:/.test(c) || /^\s*class \w+(\(.*\))?:\s*$/m.test(c)) return "python";
  if (/#include\s*<|std::|vector<\w+>|cout\s*<</.test(c)) return "cpp";
  if (/\bpublic (static )?(class|int|void|String|boolean|List<)/.test(c) || /System\.out\.println/.test(c)) return "java";
  if (/\bfun \w+\(/.test(c)) return "kotlin";
  if (/\bfunc \w+\(/.test(c) && /\bpackage \w+/.test(c)) return "go";
  if (/\bfn \w+\(.*\)\s*(->\s*[\w<>&]+)?\s*\{/.test(c)) return "rust";
  if (/\b(function|const|let)\b[\s\S]*:\s*(number|string|boolean)\b/.test(c) || /\binterface \w+\s*\{/.test(c)) return "typescript";
  if (/\bfunction \w+\(|=>\s*\{|\bconst \w+ = \(/.test(c) || /console\.log/.test(c)) return "javascript";
  if (/\bpublic (class|static|void|int)\b/.test(c) && /\bnamespace\b|\busing System/.test(c)) return "csharp";
  return null;
}

/** Only size constraints (length, n, count…) imply a complexity budget; value ranges do not. */
const SIZE_RE = /\b(length|len|size|count|number of|n|m|k|q|nodes?|edges?|rows?|queries)\b|\.length/i;
const VALUE_RE = /\[\s*\w+\s*\]|\bval(ue)?s?\b/i;

function maxConstraintPower(constraints: string[]): number | null {
  let best: number | null = null;
  for (const c of constraints) {
    if (!SIZE_RE.test(c) || (VALUE_RE.test(c) && !/length|size/i.test(c))) continue;
    for (const m of c.matchAll(/<=\s*(\d+(?:\.\d+)?)\s*(?:\*\s*)?10\^(\d+)|<=\s*10\^(\d+)|<=\s*(\d{4,})/g)) {
      const p = m[2] ? Math.log10(Number(m[1])) + Number(m[2]) : m[3] ? Number(m[3]) : Math.log10(Number(m[4]));
      if (Number.isFinite(p)) best = Math.max(best ?? 0, p);
    }
  }
  return best;
}

function complexityHint(constraints: string[]): string | null {
  const p = maxConstraintPower(constraints);
  if (p === null) return null;
  if (p <= 1.3) return "Inference from constraints: n ≤ ~20 — exponential (2^n, n!) or backtracking is feasible.";
  if (p <= 2.7) return "Inference from constraints: n ≤ ~500 — O(n^3) is likely acceptable.";
  if (p <= 3.7) return "Inference from constraints: n ≤ ~5,000 — O(n^2) is likely acceptable.";
  if (p <= 6.3) return "Inference from constraints: n up to ~10^5–10^6 — aim for O(n log n) or O(n).";
  return "Inference from constraints: very large inputs — O(log n), O(1) per query, or a math/closed-form approach is likely needed.";
}

function grab(lines: string[], i: number, stop: (l: string) => boolean): { text: string; next: number } {
  const out: string[] = [];
  let j = i;
  for (; j < lines.length; j++) {
    if (stop(lines[j]!)) break;
    out.push(lines[j]!);
  }
  return { text: out.join("\n").trim(), next: j };
}

const isHeading = (l: string) => Object.values(HEADINGS).some((re) => re.test(l));

/** Parse a problem statement. Pure; tolerant of OCR output and missing sections. */
export function parseProblem(raw: string): ParsedProblem {
  const text = normalizeNotation(raw);
  const fence = /```(\w+)?\n([\s\S]*?)```/.exec(text);
  const codeBlock = fence?.[2]?.trim() ?? null;
  const body = fence ? text.replace(fence[0], "\n") : text;
  const lines = body.split("\n");

  let inputFormat: string | null = null;
  let outputFormat: string | null = null;
  const constraints: string[] = [];
  const examples: ProblemExample[] = [];
  const statementLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // Inline forms: "Input: nums = [2,7,11,15], target = 9" inside examples.
    if (HEADINGS.example.test(l) || /^\s*(example|sample)\s*\d*\s*:/i.test(l)) {
      const ex = grab(lines, i + 1, (x) => HEADINGS.example.test(x) || /^\s*(example|sample)\s*\d*\s*:/i.test(x) || HEADINGS.constraints.test(x));
      const exText = ex.text;
      const input = /input\s*:\s*([\s\S]*?)(?=\n?\s*output\s*:|$)/i.exec(exText)?.[1]?.trim() ?? "";
      const output = /output\s*:\s*([\s\S]*?)(?=\n?\s*explanation\s*:|$)/i.exec(exText)?.[1]?.trim() ?? "";
      const explanation = /explanation\s*:\s*([\s\S]*)$/i.exec(exText)?.[1]?.trim() ?? null;
      if (input || output) examples.push({ input, output, explanation });
      i = ex.next - 1;
      continue;
    }
    if (HEADINGS.constraints.test(l)) {
      const c = grab(lines, i + 1, (x) => isHeading(x));
      constraints.push(...c.text.split("\n").map((x) => x.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean));
      i = c.next - 1;
      continue;
    }
    if (HEADINGS.input.test(l) && !inputFormat) {
      const c = grab(lines, i + 1, (x) => isHeading(x));
      inputFormat = c.text || null;
      i = c.next - 1;
      continue;
    }
    if (HEADINGS.output.test(l) && !outputFormat) {
      const c = grab(lines, i + 1, (x) => isHeading(x));
      outputFormat = c.text || null;
      i = c.next - 1;
      continue;
    }
    statementLines.push(l);
  }
  // Constraints written inline as bullet lines with comparison operators.
  if (!constraints.length) {
    for (const l of statementLines) if (/^\s*[-*•]?\s*[\w\s.[\]()|]+\s*(<=|>=|<|>)\s*[\w^.*\s]+(<=|<)?/.test(l) && /\d/.test(l) && l.length < 80) constraints.push(l.replace(/^\s*[-*•]\s+/, "").trim());
  }
  const statementAll = statementLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const titleMatch = /^\s*(?:\d+\.\s*)?([A-Z][\w ,'()-]{2,60})\s*$/m.exec(statementAll.split("\n")[0] ?? "");
  const title = titleMatch && statementAll.split("\n").length > 1 ? titleMatch[1]!.trim() : null;
  const statement = title ? statementAll.split("\n").slice(1).join("\n").trim() : statementAll;

  const code = codeBlock ?? (/(def |class |function |public |#include|SELECT )/.test(body) ? body.split("\n").filter((l) => /^\s{2,}|[{};:]\s*$|^(def|class|function|public|#include|SELECT)\b/.test(l)).join("\n") || null : null);
  const signature = code ? (/(def \w+\([^)]*\)[^:\n]*:|(public|private|static|\w+)[\w<>[\], ]*\s+\w+\([^)]*\)\s*\{|function \w+\([^)]*\)|\w+\s*\([^)]*\)\s*(->|:)\s*[\w<>[\]]+)/.exec(code)?.[0] ?? null) : null;
  const sqlish = /\b(table|column|sql|query|rows?)\b/i.test(statement) && /\b(select|join|group by|schema|table)\b/i.test(text);
  const design = /\bdesign (a|an|the)\b|\bsystem design\b|\bscal(e|ability)\b/i.test(statement) && !examples.length;
  const debugging = /\b(error|exception|traceback|fails?|bug|wrong answer|stack trace|segfault)\b/i.test(text) && !!code;
  const problemish = /\b(given|return|find|compute|determine|implement|write a function|array|string|integers?|linked list|tree|graph|matrix)\b/i.test(statement);
  const kind: ParsedProblem["kind"] = sqlish ? "sql" : design ? "system_design" : debugging ? "debugging" : examples.length || constraints.length || signature || problemish ? "algorithm" : "concept";

  const missing: string[] = [];
  if (kind === "algorithm" || kind === "sql") {
    if (!statement || statement.length < 40) missing.push("the full problem statement");
    if (!examples.length) missing.push("at least one example (input and expected output)");
    if (kind === "algorithm" && !constraints.length) missing.push("the constraints (input sizes / value ranges)");
    if (kind === "sql" && !/\b(table|schema|columns?)\b/i.test(text)) missing.push("the table schema");
  }
  const lastLine = text.trim().split("\n").at(-1) ?? "";
  const looksTruncated = /[,([{=]$|\b(the|a|an|of|to|and|is|with)$/i.test(lastLine.trim()) || (examples.at(-1)?.output === "" && examples.length > 0);
  if (looksTruncated) missing.push("the rest of the text (it appears to be cut off)");

  return {
    title,
    statement,
    inputFormat,
    outputFormat,
    constraints,
    examples,
    signature,
    starterCode: codeBlock,
    detectedLanguage: code ? detectLanguage(code) : null,
    kind,
    complexityHint: complexityHint(constraints),
    missing,
    looksTruncated,
  };
}

/** Render the parsed structure as an untrusted-context block for the model (what was observed). */
export function problemToContext(p: ParsedProblem): string {
  const parts = [
    p.title ? `Title: ${p.title}` : "",
    `Statement:\n${p.statement || "(not provided)"}`,
    p.inputFormat ? `Input format:\n${p.inputFormat}` : "",
    p.outputFormat ? `Output format:\n${p.outputFormat}` : "",
    p.constraints.length ? `Constraints:\n${p.constraints.map((c) => `- ${c}`).join("\n")}` : "Constraints: (not provided)",
    p.examples.length
      ? p.examples.map((e, i) => `Example ${i + 1}:\nInput: ${e.input}\nOutput: ${e.output}${e.explanation ? `\nExplanation: ${e.explanation}` : ""}`).join("\n\n")
      : "Examples: (not provided)",
    p.starterCode ? `Starter code (${p.detectedLanguage ?? "unknown language"}):\n${p.starterCode}` : "",
    p.signature ? `Signature: ${p.signature}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}
