// Response strategy: turns (relation, category, depth, preferences) into one trusted system
// instruction. Preferences live here once, so they are applied consistently without being repeated
// in every workflow prompt.

import { LANGUAGES, type Language } from "../technical/problem";
import { CODE_CATEGORIES, TASK_LABELS, type TaskCategory } from "./classify";
import { RELATION_LABELS, type ResolvedTurn, type TurnRelation } from "./turns";

export type Depth = "quick" | "balanced" | "deep";

export const DEPTH_LABELS: Record<Depth, string> = { quick: "Quick", balanced: "Balanced", deep: "Deep" };

export interface Preferences {
  depth: Depth;
  language: Language;
  alsoKnows: Language[];
  level: "junior" | "mid" | "senior";
  codeStyle: "idiomatic" | "commented" | "compact";
  hintsFirst: boolean;
  includeComplexity: boolean;
  includeTests: boolean;
}

const DEPTH_RULE: Record<Depth, string> = {
  quick: "Depth: quick. Put the direct answer first. Minimal explanation; include code only if the question needs it. Aim for something readable in about 15 seconds.",
  balanced: "Depth: balanced. Give the answer, the key reasoning, and the most important caveat or example. No exhaustive coverage.",
  deep: "Depth: deep. Give detailed reasoning, alternatives with trade-offs, edge cases, and how to verify the result.",
};

const LEVEL_RULE: Record<Preferences["level"], string> = {
  junior: "The user is a junior engineer: define terms briefly and avoid unexplained jargon.",
  mid: "The user is a mid-level engineer.",
  senior: "The user is a senior engineer: skip basics and focus on trade-offs and production concerns.",
};

const CODE_STYLE_RULE: Record<Preferences["codeStyle"], string> = {
  idiomatic: "Code style: idiomatic and readable, with brief comments only where the logic is non-obvious.",
  commented: "Code style: comment each non-trivial step so the code can be explained line by line.",
  compact: "Code style: compact; no comments unless essential.",
};

/** Stable per-user preferences block (system prompt). */
export function preferencesBlock(p: Preferences): string {
  const lang = LANGUAGES.find((l) => l.id === p.language)!.label;
  const others = p.alsoKnows.filter((l) => l !== p.language).map((l) => LANGUAGES.find((x) => x.id === l)!.label);
  return [
    "User preferences (set by the user in Lumen):",
    `- Default programming language: ${lang}${others.length ? `; also comfortable with ${others.join(", ")}` : ""}. Use the default unless the user or the problem specifies another language.`,
    `- ${LEVEL_RULE[p.level]}`,
    `- ${CODE_STYLE_RULE[p.codeStyle]}`,
    `- For code answers: ${p.includeComplexity ? "state time and space complexity" : "omit complexity analysis unless asked"}; ${p.includeTests ? "include a few test cases" : "omit test cases unless asked"}.`,
    "- Test cases you write are reasoned, not executed: label expected outputs as “expected (not run)”. Never claim code was run.",
  ].join("\n");
}

const CATEGORY_RULE: Record<TaskCategory, Record<Depth, string>> = {
  algorithm: {
    quick: "Algorithm question: name the approach in one line, then the code, then complexity in one line.",
    balanced: "Algorithm question: approach (pattern and the core invariant), code, complexity, key edge cases.",
    deep: "Algorithm question: restate inputs/outputs and constraints, list assumptions, explain the approach and its invariant, trace one example, give code, complexity, edge cases, tests, and an alternative approach with trade-offs.",
  },
  debugging: {
    quick: "Debugging: point to the most likely faulty line and give the minimal fix.",
    balanced: "Debugging: identify the likely failure, explain why it happens, and give a targeted patch (quote the original line, then the corrected one).",
    deep: "Debugging: list the candidate causes ranked by likelihood with evidence from the code/error, explain the root cause, give the corrected implementation, and how to verify the fix.",
  },
  code_explanation: {
    quick: "Code explanation: one-paragraph summary of what the code does.",
    balanced: "Code explanation: summary, then the key steps with line references, then any bug or edge case it mishandles.",
    deep: "Code explanation: walk through it section by section with line references, its complexity, edge cases, and possible improvements.",
  },
  system_design: {
    quick: "System design: core components and data flow in a few bullets, plus the main trade-off.",
    balanced: "System design: requirements and assumptions, components and data flow, data model, the key bottleneck and trade-off.",
    deep: "System design: functional and non-functional requirements, estimates if numbers are given, API contracts, data model, component boundaries, scalability, consistency, reliability, security, and trade-offs.",
  },
  language_framework: {
    quick: "Language/framework question: answer directly with a minimal example if useful.",
    balanced: "Language/framework question: answer, the mechanism behind it, and a short example or pitfall.",
    deep: "Language/framework question: explain the mechanism, version-specific behaviour, examples, pitfalls and alternatives.",
  },
  database_sql: {
    quick: "Database/SQL: give the query or answer directly.",
    balanced: "Database/SQL: give the query, explain the joins/grouping, and note an index or edge case (NULLs, duplicates).",
    deep: "Database/SQL: state schema assumptions, give the query, explain it, discuss NULLs/duplicates/ties, indexes, and an alternative formulation.",
  },
  api_backend: {
    quick: "API/backend: direct recommendation with the key reason.",
    balanced: "API/backend: recommendation, the contract (endpoints/status codes or interfaces), and the main failure mode to handle.",
    deep: "API/backend: contracts, data flow, error handling, idempotency, security, observability and trade-offs.",
  },
  frontend: {
    quick: "Frontend: direct answer with a minimal snippet if needed.",
    balanced: "Frontend: answer, the snippet, and one accessibility or performance caveat.",
    deep: "Frontend: implementation, state/data flow, accessibility, performance and testing considerations.",
  },
  testing: {
    quick: "Testing: list the essential test cases.",
    balanced: "Testing: test cases grouped by normal/edge/error, and the tests in the requested framework.",
    deep: "Testing: test strategy (unit/integration), cases by category, the tests, fixtures/mocks, and what remains untested.",
  },
  behavioral: {
    quick: "Behavioral question: a short STAR outline using only the user's own experience from context (cite it). If none is in context, give the structure with [placeholders] and say what to add. Never invent employers, projects, metrics or achievements.",
    balanced: "Behavioral question: a STAR answer built only from the user's documented experience in context, with citations; use [placeholders] for anything missing. Never invent employers, projects, metrics or achievements.",
    deep: "Behavioral question: a full STAR answer from the user's documented experience (cited), likely follow-up questions, and what to emphasize. Use [placeholders] for missing facts; never invent experience.",
  },
  project: {
    quick: "Project discussion: a 3-point outline (problem, the user's role, outcome) from the user's documented projects.",
    balanced: "Project discussion: problem, the user's role, key technical decisions, outcome — only from documented facts in context, cited.",
    deep: "Project discussion: problem, role, architecture and decisions, trade-offs, outcome, lessons learned, and likely follow-ups — only documented facts, cited.",
  },
  meeting_summary: {
    quick: "Meeting summary: 3 bullets from the transcript only.",
    balanced: "Meeting summary from the transcript only: summary, decisions, action items (owner if stated), open questions. Cite transcript lines.",
    deep: "Meeting summary from the transcript only: summary, discussion points, decisions, action items, open questions and suggested follow-ups, with citations.",
  },
  general: {
    quick: "Answer directly.",
    balanced: "Answer, with the key reasoning.",
    deep: "Answer thoroughly, including caveats and alternatives.",
  },
};

const RELATION_RULE: Record<TurnRelation, string | null> = {
  new: null,
  follow_up: "This message is a follow-up to the previous question in this conversation: answer it in the context of that same problem; do not ask the user to repeat it.",
  simplify: "The user wants your previous answer simpler: restate it in plain language, shorter, with one concrete example and no new material.",
  elaborate: "The user wants you to elaborate on your previous answer: go deeper on the same topic without repeating it verbatim.",
  correction: "The user is correcting an earlier assumption or answer: acknowledge the correction in one line, drop the wrong assumption, and redo the answer under the corrected premise.",
  screen: "The user is asking about what is on their screen: base the answer on the captured screen sources in <context> and reference the captured code or text (quote it) rather than inventing a different implementation. If the capture is incomplete or unreadable, say exactly what is missing and ask for a clearer capture. You only see what was captured — not other tabs, windows, files or screens.",
  revise_code: "The user wants the code from your previous answer revised: apply the requested change to that code, show the updated code, and list what changed.",
};

export interface Strategy {
  depth: Depth;
  hintsOnly: boolean;
  instruction: string;
  label: string;
}

const WANTS_SOLUTION = /\b(solution|solve|code|implement|write|show me|full answer|give me the answer)\b/i;

export function buildStrategy(turn: ResolvedTurn, category: TaskCategory, prefs: Preferences, opts: { depth?: Depth; hasWorkflow: boolean }): Strategy {
  const depth = opts.depth ?? prefs.depth;
  const lines: string[] = [];
  const relationRule = RELATION_RULE[turn.relation];
  if (relationRule) lines.push(relationRule);
  if (turn.ambiguous) lines.push("The message is too short or vague to answer reliably and there is no earlier turn it could refer to: ask one short clarifying question (offer 2–3 likely interpretations) instead of guessing.");
  if (turn.requestedLanguage) {
    const l = LANGUAGES.find((x) => x.id === turn.requestedLanguage)!;
    lines.push(`The user asked for ${l.label}: use ${l.label} for code in this answer (fence as \`\`\`${l.fence}).`);
  }
  // Mode workflows (interview/technical) supply their own structure; only depth applies on top.
  let hintsOnly = false;
  if (!opts.hasWorkflow) {
    hintsOnly = prefs.hintsFirst && category === "algorithm" && turn.relation === "new" && !WANTS_SOLUTION.test(turn.retrievalQuery);
    lines.push(
      hintsOnly
        ? "Hints first (user preference): give 2–3 progressively stronger hints and the approach name, but no code and no full solution. End by offering the full solution."
        : CATEGORY_RULE[category][depth],
    );
  }
  lines.push(DEPTH_RULE[depth]);
  if (CODE_CATEGORIES.has(category) && !opts.hasWorkflow) lines.push("Separate facts taken from the context (cited) from assumptions you introduce (prefix them “Assumption:”).");
  return {
    depth,
    hintsOnly,
    instruction: lines.join("\n"),
    label: [RELATION_LABELS[turn.relation], TASK_LABELS[category], hintsOnly ? "Hints" : DEPTH_LABELS[depth]].join(" · "),
  };
}
