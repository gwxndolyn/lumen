// Deterministic answer checks run after generation. No model call: they inspect the answer text
// against the request, the plan and the context that was actually sent. Findings are shown to the
// user and recorded in metrics; they never silently rewrite the answer.

import type { ContextReference } from "../../shared/types";
import type { TaskCategory } from "./classify";
import { checkCodeBlocks, type CodeCheck } from "./codeCheck";

export type CheckId =
  | "unclosed_code_fence"
  | "unknown_citation"
  | "claims_execution"
  | "claims_unavailable_source"
  | "missing_requested_language"
  | "missing_code"
  | "repetition"
  | "too_long_for_depth"
  | "truncated"
  | "code_syntax"
  | "invented_owner"
  | "uncited_summary"
  | "fabricated_url";

export interface Finding {
  check: CheckId;
  severity: "warn" | "info";
  /** Short user-facing explanation. */
  message: string;
}

export interface VerifyInput {
  answer: string;
  references: ContextReference[];
  category: TaskCategory;
  depth: "quick" | "balanced" | "deep";
  requestedLanguage: string | null;
  /** What was really available to the model for this request. */
  available: { transcript: boolean; screen: boolean };
  hintsOnly: boolean;
  stopReason: string;
  /** Text of the sources that were sent (by label), for grounding checks. */
  sourceText?: Record<string, string>;
}

export interface VerifyResult {
  findings: Finding[];
  checksRun: CheckId[];
  /** Per-block syntax results (passed / failed / unavailable / skipped). Never "executed". */
  code: CodeCheck[];
}

const FENCE_ALIASES: Record<string, string[]> = {
  python: ["python", "py"],
  java: ["java"],
  javascript: ["javascript", "js", "jsx"],
  typescript: ["typescript", "ts", "tsx"],
  cpp: ["cpp", "c++", "cc", "cxx"],
  sql: ["sql", "postgresql", "mysql"],
  go: ["go", "golang"],
  csharp: ["csharp", "cs", "c#"],
  kotlin: ["kotlin", "kt"],
  rust: ["rust", "rs"],
};

/** Word budget per depth; generous so only clearly runaway answers are flagged. */
const WORD_LIMIT: Record<VerifyInput["depth"], number> = { quick: 450, balanced: 900, deep: 2500 };

/** Phrases asserting the model ran something. Lumen never executes code, so these are always false. */
const EXECUTION_CLAIM =
  /\b(i (ran|executed|tested) (the|this|your) (code|tests?|script|program|query)|i('ve| have) (run|executed|tested) (it|the|this|your)|when i ran (it|the code|this)|after running (it|the code)|tests? passed when i ran)\b/i;

const TRANSCRIPT_CLAIM = /\b(in the (transcript|recording|meeting audio)|(the )?transcript (shows|says|mentions)|(was|were) (said|mentioned) (in|during) the (call|meeting))\b/i;
const SCREEN_CLAIM = /\b(on your screen|in (your|the) screenshot|the screenshot shows|(i can )?see on (your|the) screen)\b/i;

/** Categories whose answers normally need code, unless the user asked for hints only. */
const NEEDS_CODE: ReadonlySet<TaskCategory> = new Set(["algorithm", "debugging"]);

function codeBlocks(answer: string): { lang: string; body: string }[] {
  return [...answer.matchAll(/```([\w+#-]*)\n([\s\S]*?)```/g)].map((m) => ({ lang: (m[1] ?? "").toLowerCase(), body: m[2] ?? "" }));
}

/** Longest run of a repeated sentence (normalized), to catch looping output. */
function maxRepeat(answer: string): number {
  const counts = new Map<string, number>();
  const prose = answer.replace(/```[\s\S]*?```/g, " ");
  for (const s of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const k = s.trim().toLowerCase().replace(/\s+/g, " ");
    if (k.length < 25) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export function verifyAnswer(i: VerifyInput): VerifyResult {
  const findings: Finding[] = [];
  const checksRun: CheckId[] = [];
  const run = (id: CheckId, failed: boolean, f: Omit<Finding, "check">) => {
    checksRun.push(id);
    if (failed) findings.push({ check: id, ...f });
  };

  const fences = (i.answer.match(/^```/gm) ?? []).length;
  run("unclosed_code_fence", fences % 2 === 1, { severity: "warn", message: "A code block is not closed, so the code may be incomplete." });

  run("truncated", i.stopReason === "max_tokens", { severity: "warn", message: "The answer hit the output limit and is cut off." });

  const labels = new Set(i.references.map((r) => r.label));
  const cited = [...i.answer.matchAll(/\[(C\d+(?:\s*,\s*C\d+)*)\]/g)].flatMap((m) => m[1]!.split(/\s*,\s*/));
  const unknown = [...new Set(cited.filter((c) => !labels.has(c)))];
  run("unknown_citation", unknown.length > 0, { severity: "warn", message: `Cites ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not among the sources provided.` });

  run("claims_execution", EXECUTION_CLAIM.test(i.answer), { severity: "warn", message: "Claims code was run. Lumen does not execute code, so any outputs shown are expected, not observed." });

  const heardMissing = !i.available.transcript && TRANSCRIPT_CLAIM.test(i.answer);
  const sawMissing = !i.available.screen && SCREEN_CLAIM.test(i.answer);
  run("claims_unavailable_source", heardMissing || sawMissing, {
    severity: "warn",
    message: `Refers to ${heardMissing ? "a transcript" : "your screen"}, but none was included with this question.`,
  });

  const blocks = codeBlocks(i.answer);
  if (i.requestedLanguage && blocks.length) {
    const want = FENCE_ALIASES[i.requestedLanguage] ?? [i.requestedLanguage];
    const tagged = blocks.filter((b) => b.lang);
    run("missing_requested_language", tagged.length > 0 && !tagged.some((b) => want.includes(b.lang)), {
      severity: "warn",
      message: `You asked for ${i.requestedLanguage}, but the code is in ${[...new Set(tagged.map((b) => b.lang))].join(", ")}.`,
    });
  }

  if (NEEDS_CODE.has(i.category) && !i.hintsOnly) {
    run("missing_code", blocks.length === 0 && !/\?\s*$/.test(i.answer.trim()), { severity: "info", message: "No code was included; ask for the implementation if you need it." });
  }

  run("repetition", maxRepeat(i.answer) >= 3, { severity: "warn", message: "The answer repeats itself." });

  const words = i.answer
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  run("too_long_for_depth", words > WORD_LIMIT[i.depth], { severity: "info", message: `Longer than usual for a ${i.depth} answer (${words} words).` });

  // Syntax: deterministic parse of each code block (nothing is run). Only failures become findings;
  // "unavailable" is reported per block so the UI can say a language was not checked.
  const code = checkCodeBlocks(i.answer);
  const bad = code.filter((c) => c.status === "failed");
  if (code.some((c) => c.status === "passed" || c.status === "failed"))
    run("code_syntax", bad.length > 0, { severity: "warn", message: `Code block ${bad.map((b) => b.block + 1).join(", ")} does not parse: ${bad[0]?.detail ?? ""}`.slice(0, 240) });

  // Notes and summaries: an action-item owner or deadline must appear in the sources.
  const sources = Object.values(i.sourceText ?? {})
    .join("\n")
    .toLowerCase();
  if ((i.category === "meeting_summary" || i.category === "notes") && sources) {
    // "Owner: Alice", "owner — Alice", "Alice (owner)", "assigned to Alice". Names must start upper-case.
    const owners = [
      ...[...i.answer.matchAll(/\b(?:owner|assigned to|assignee|responsible)\s*[:\-–—]?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/gi)].map((m) => m[1]!),
      ...[...i.answer.matchAll(/\b([A-Z][a-z]+)\s*\((?:owner|assignee)\)/g)].map((m) => m[1]!),
    ].filter((n) => /^[A-Z]/.test(n) && !/^(Not|None|Tbd|Unknown|Unassigned|Unclear|Someone|Nobody|Stated)$/i.test(n.split(" ")[0]!));
    const invented = [...new Set(owners.filter((o) => !sources.includes(o.toLowerCase())))];
    run("invented_owner", invented.length > 0, {
      severity: "warn",
      message: `Names ${invented.join(", ")} as an owner, but ${invented.length === 1 ? "that name does" : "those names do"} not appear in the sources.`,
    });
  }
  // A summary of supplied material should point at it.
  if ((i.category === "summarization" || i.category === "notes" || i.category === "meeting_summary") && i.references.length) {
    run("uncited_summary", cited.length === 0 && !/no (source|transcript|document)|not (included|provided|available)/i.test(i.answer), {
      severity: "info",
      message: "This summary does not cite its sources, so its points can't be traced back to them.",
    });
  }
  // Lumen has no browsing: a URL that isn't in the sources was produced from memory.
  const urls = [...new Set([...i.answer.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))];
  if (urls.length && i.category === "research") {
    const unknownUrls = urls.filter((u) => !sources.includes(u.toLowerCase()));
    run("fabricated_url", unknownUrls.length > 0, {
      severity: "warn",
      message: `Links to ${unknownUrls.length === 1 ? "a page" : `${unknownUrls.length} pages`} that are not in your sources. Lumen can't browse, so ${unknownUrls.length === 1 ? "it was" : "they were"} written from memory and may not exist.`,
    });
  }

  return { findings, checksRun, code };
}
