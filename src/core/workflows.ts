// Mode-specific response pipelines layered on the shared context engine and chat service.
// Each builds a precise instruction for one task; the context gathering, isolation, grounding
// policy, streaming, persistence and provider abstraction are the same as every other answer.

import { CATEGORY_LABELS, type DetectedQuestion, type QuestionCategory } from "./interview/questions";
import { LANGUAGES, type Language, type ParsedProblem } from "./technical/problem";

export type AnswerLength = "short" | "medium" | "detailed";

const LENGTH_RULE: Record<AnswerLength, string> = {
  short: "Keep it to what can be read in ~10 seconds: an opening line and 2–3 bullets.",
  medium: "Opening line, 3–5 bullets, and one concrete example.",
  detailed: "Opening line, structured bullets, a worked example, and likely follow-ups.",
};

const CATEGORY_GUIDE: Record<QuestionCategory, string> = {
  introduction: "Structure: present role → relevant past → why this role. 60–90 seconds spoken.",
  behavioral: "Use STAR (Situation, Task, Action, Result). Emphasize the user's own actions and a measurable result only if one appears in their profile.",
  project: "Structure: problem → the user's role → key technical decisions → outcome → what they would do differently.",
  technical: "Explain from intuition to mechanics, then a one-line example. Note a common pitfall.",
  coding: "Do not dump code: clarify inputs/constraints, state the approach and its complexity, then outline the code. Offer to switch to the Technical workspace for full code.",
  system_design: "Structure: clarify requirements and scale → high-level components → data model → bottlenecks and trade-offs. Ask clarifying questions first.",
  product: "Structure: clarify the goal → define the metric(s) → hypotheses → how to validate.",
  tradeoff: "Name the options, the decision criteria, the choice and why, and what was given up.",
  experience: "Answer directly from the user's documented experience; be specific about scope and tools.",
  other: "Answer directly and briefly.",
};

/**
 * Prompt for a suggested interview answer. Grounding rules: personal facts may come only from the
 * profile/resume/notes in context; anything missing is flagged rather than invented.
 */
export function interviewPrompt(q: Pick<DetectedQuestion, "text" | "category">, length: AnswerLength): string {
  return [
    `Interview question (${CATEGORY_LABELS[q.category]}): "${q.text}"`,
    "",
    "Write a suggested answer for me to say, in my own voice, using this exact layout:",
    "**Opening:** one sentence I can start with.",
    "**Talking points:** bullets.",
    "**My example:** the most relevant example from MY profile/resume/notes in context, cited [Cn]. If none fits, write “No matching example in your profile — add one about …” instead of inventing one.",
    "**If they follow up:** 1–2 likely follow-up questions.",
    "",
    CATEGORY_GUIDE[q.category],
    LENGTH_RULE[length],
    "Never invent employers, projects, dates, metrics, titles or credentials. Facts about me must come from context with a citation; anything else must be phrased as a placeholder like [your metric].",
  ].join("\n");
}

export type TechnicalTask = "solve" | "explain" | "debug" | "review" | "tests" | "complexity" | "refactor" | "hints";

const TASK_SPEC: Record<TechnicalTask, string> = {
  solve: [
    "Work through it in this order, with these headings:",
    "1. **Understanding** — restate the task, inputs and outputs in one or two lines.",
    "2. **Constraints & edge cases** — from the given constraints (quote them); list edge cases (empty, single element, duplicates, negatives, overflow, ties).",
    "3. **Approach** — name the pattern (e.g. two pointers, sliding window, BFS, DP, heap, union-find), why it fits, and briefly why simpler approaches fail the constraints.",
    "4. **Walkthrough** — trace Example 1 step by step.",
    "5. **Code** — one complete, idiomatic solution in the requested language in a fenced block.",
    "6. **Complexity** — time and space, with a one-line justification each.",
    "7. **Tests** — 3–5 extra test cases including the edge cases, with expected outputs.",
  ].join("\n"),
  explain: "Explain what the given code does, step by step, then its time/space complexity and any edge cases it mishandles.",
  debug: "Find the bug(s): quote the faulty line(s), explain why they are wrong using the error/failing case if given, and show the corrected code in a fenced block. Do not rewrite unrelated parts.",
  review: "Review the code: correctness issues first, then edge cases, then complexity, then readability/idioms. Use a short bullet list with line references, then show an improved version.",
  tests: "Write a focused test suite for the code/problem in the requested language's standard test framework, covering normal cases, edge cases and the given examples. State expected outputs.",
  complexity: "Analyze time and space complexity precisely (best/average/worst if they differ), identify the dominant operation, and say whether it fits the constraints.",
  refactor: "Suggest a refactor that keeps behavior identical: explain the improvements, then show the refactored code.",
  hints: "Practice mode: do NOT give the solution or code. Give three progressively stronger hints (pattern → key observation → algorithm outline), each under its own heading, so the user can solve it themselves.",
};

const LANG_RULES: Record<Language, string> = {
  python: "Python 3: type hints, PEP 8, standard library only (collections, heapq, bisect, itertools). Note that Python ints don't overflow.",
  java: "Java 17: a `class Solution` with the method, standard library collections; note int overflow (use long where needed).",
  javascript: "Modern JavaScript (ES2022): `function` or arrow functions, `Map`/`Set`; note that numbers are doubles (use BigInt above 2^53).",
  typescript: "TypeScript with explicit parameter/return types; no `any`.",
  cpp: "C++17: `std::vector`, `unordered_map`, `<algorithm>`; pass by const reference; note overflow (use long long).",
  sql: "ANSI SQL first; if a dialect matters (PostgreSQL / MySQL), say which. Explain joins and grouping; mention indexes that would help.",
  go: "Go: idiomatic, standard library only.",
  csharp: "C# 12 / .NET: idiomatic LINQ only where it stays clear.",
  kotlin: "Kotlin: idiomatic stdlib collections.",
  rust: "Rust (2021 edition): idiomatic ownership; no unsafe.",
};

export function technicalPrompt(task: TechnicalTask, language: Language, problem: ParsedProblem | null, userText: string): string {
  const lang = LANGUAGES.find((l) => l.id === language)!;
  const lines = [
    userText.trim() ? `My request: ${userText.trim()}` : "",
    `Task: ${task}. Language: ${lang.label} (fence code as \`\`\`${lang.fence}).`,
    TASK_SPEC[task],
    LANG_RULES[language],
  ];
  if (problem) {
    if (problem.missing.length) {
      lines.push(
        `The problem as captured is missing: ${problem.missing.join("; ")}. Start by saying exactly what is missing. Only continue if the task is still well-defined, and label every assumption you make as “Assumption:”.`,
      );
    }
    if (problem.complexityHint) lines.push(problem.complexityHint);
  }
  lines.push(
    "Base the analysis only on the problem/code in context (cite it [Cn]). If something is unreadable or absent, ask for it rather than guessing. Never claim code was run: say “not executed” when giving expected outputs.",
  );
  return lines.filter(Boolean).join("\n\n");
}

export const NOTES_SECTIONS = [
  "summary",
  "discussionPoints",
  "questionsAsked",
  "topics",
  "decisions",
  "actionItems",
  "unansweredQuestions",
  "followUpPrep",
  "conceptsToRevisit",
] as const;
