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
    quick:
      "Behavioral question: a short STAR outline using only the user's own experience from context (cite it). If none is in context, give the structure with [placeholders] and say what to add. Never invent employers, projects, metrics or achievements.",
    balanced:
      "Behavioral question: a STAR answer built only from the user's documented experience in context, with citations; use [placeholders] for anything missing. Never invent employers, projects, metrics or achievements.",
    deep: "Behavioral question: a full STAR answer from the user's documented experience (cited), likely follow-up questions, and what to emphasize. Use [placeholders] for missing facts; never invent experience.",
  },
  project: {
    quick: "Project discussion: a 3-point outline (problem, the user's role, outcome) from the user's documented projects.",
    balanced: "Project discussion: problem, the user's role, key technical decisions, outcome — only from documented facts in context, cited.",
    deep: "Project discussion: problem, role, architecture and decisions, trade-offs, outcome, lessons learned, and likely follow-ups — only documented facts, cited.",
  },
  meeting_summary: {
    quick: "Meeting summary: 3 bullets from the transcript only.",
    balanced:
      "Meeting summary from the transcript only: summary, decisions, action items, open questions. Cite transcript lines. An action item's owner and deadline are listed only if someone in the transcript stated them; otherwise write “owner: not stated”. Separate what was said from what you infer.",
    deep: "Meeting summary from the transcript only: summary, discussion points, decisions, action items, open questions and suggested follow-ups, with citations.",
  },
  code_generation: {
    quick: "Code generation: the code, with the imports it needs, then one line on how to use it. State any assumption about inputs in one line.",
    balanced:
      "Code generation: restate the requirements you are implementing in one line (language, inputs, outputs, constraints). Follow conventions visible in the context or project memory (cite them). Give complete code with imports, then how to integrate or call it, then assumptions and limitations.",
    deep: "Code generation: requirements and constraints; design choices and why; complete code with imports following the project's conventions (cite them); integration steps; error handling; tests (reasoned, not run); assumptions and limitations.",
  },
  code_review: {
    quick: "Code review: list the most important concrete defects only, each with where it is and the fix.",
    balanced:
      "Code review of the supplied code only. Order findings by impact: correctness, security, data integrity, then maintainability. For each: location (line or function, only if it is visible in the code), what goes wrong and when, and the fix. Put defects you can show in a section “Confirmed issues” and things that depend on unseen code in “Possible concerns”. No style nitpicks unless asked. If you find nothing serious, say so.",
    deep: "Code review of the supplied code only: “Confirmed issues” (location, failing input or scenario, fix), “Possible concerns” (what you would need to see to confirm), then maintainability and test gaps. Order by impact (correctness, security, data integrity first). Never invent file names or line numbers that are not in the code.",
  },
  refactoring: {
    quick: "Refactoring: the refactored code, then one line on what changed. Keep behaviour identical.",
    balanced: "Refactoring: keep external behaviour identical. Show the refactored code, then a short list of what changed and why, and anything whose behaviour you could not preserve or verify.",
    deep: "Refactoring: identify the problems in the current structure, the target structure, the refactored code (behaviour preserved), a list of changes, how to verify behaviour is unchanged (tests to run), and risks.",
  },
  summarization: {
    quick: "Summary: the main point in 1–3 sentences, from the supplied material only.",
    balanced:
      "Summary of the supplied material only (cite it): the key points, keeping important numbers, names and qualifications. Do not add facts that are not in the source. Match any length or format the user asked for. If no source material is in <context>, say what is missing instead of summarising.",
    deep: "Summary of the supplied material only (cite it): overview, key points with their qualifications, numbers and names preserved, open questions or caveats the source states. No facts that are not in the source. If no source is in <context>, say so.",
  },
  research: {
    quick: "Research question: answer briefly, marking what comes from the supplied sources (cited) and what is general knowledge.",
    balanced:
      "Research question. Lumen has no web access: only sources in <context> are retrieved evidence. Cite them for every claim they support. Anything else is your general knowledge — label it “General knowledge:” and say it may be out of date. Never invent sources, URLs or citations. If the evidence is insufficient, say so and say what would settle it.",
    deep: "Research question. Only sources in <context> are evidence (cite them); label everything else “General knowledge:” with its likely age. Compare the evidence, note disagreements and gaps, and say what source would settle open points. Never invent sources, URLs or citations.",
  },
  planning: {
    quick: "Planning: a short ordered list of steps or milestones.",
    balanced:
      "Planning: goal and assumptions, then milestones with the tasks in each, dependencies and the main risk. Only state durations, owners or dates the user gave; otherwise mark them “to estimate” or “owner: TBD”.",
    deep: "Planning: goal, scope and assumptions; phases with tasks, dependencies and acceptance criteria; risks and mitigations; open decisions. Never invent owners, dates or estimates — use “TBD” unless the user supplied them.",
  },
  notes: {
    quick: "Notes: the key points as bullets, from the supplied material only.",
    balanced:
      "Notes from the supplied material only: headings by topic, concise bullets that keep the original meaning, key terms defined. Mark anything you infer as “Inference:”. If the material is unclear or incomplete, say where instead of filling gaps.",
    deep: "Notes from the supplied material only: headings, bullets, definitions, examples given in the source, and a short list of questions the material leaves open. Mark inferences “Inference:”; never add content the source does not contain.",
  },
  // Also the fallback when the rules could not classify the request, so it tells the model to pick
  // the right shape itself rather than forcing a generic answer onto a technical question.
  general: {
    quick:
      "Answer directly. If this is actually a coding, debugging, design or interview question, use the shortest structure that fits it (e.g. cause + fix for a bug, approach + code for a problem).",
    balanced: "Answer, with the key reasoning. If this is a coding, debugging, system-design or behavioral question, structure it the way that task needs (e.g. root cause → fix → test for a bug).",
    deep: "Answer thoroughly, including caveats and alternatives. If this is a technical task, use the structure that task needs (requirements → design → trade-offs for design; approach → code → complexity → edge cases for algorithms).",
  },
};

const RELATION_RULE: Record<TurnRelation, string | null> = {
  new: null,
  follow_up: "This message is a follow-up to the previous question in this conversation: answer it in the context of that same problem; do not ask the user to repeat it.",
  simplify: "The user wants your previous answer simpler: restate it in plain language, shorter, with one concrete example and no new material.",
  elaborate: "The user wants you to elaborate on your previous answer: go deeper on the same topic without repeating it verbatim.",
  correction: "The user is correcting an earlier assumption or answer: acknowledge the correction in one line, drop the wrong assumption, and redo the answer under the corrected premise.",
  screen:
    "The user is asking about what is on their screen: base the answer on the captured screen sources in <context> and reference the captured code or text (quote it) rather than inventing a different implementation. If the capture is incomplete or unreadable, say exactly what is missing and ask for a clearer capture. You only see what was captured — not other tabs, windows, files or screens.",
  revise_code: "The user wants the code from your previous answer revised: apply the requested change to that code, show the updated code, and list what changed.",
};

export interface Strategy {
  depth: Depth;
  hintsOnly: boolean;
  instruction: string;
  label: string;
}

const WANTS_SOLUTION = /\b(solution|solve|code|implement|write|show me|full answer|give me the answer)\b/i;

/**
 * Rules that hold at every depth. Depth changes how much is written, never whether facts may be
 * invented, so these are applied on top of the depth-specific template.
 */
const INVARIANT_RULE: Partial<Record<TaskCategory, string>> = {
  meeting_summary: "Only list an owner or deadline for an action item if someone in the transcript stated it; otherwise write “owner: not stated”. Never invent who said or agreed to something.",
  notes: "Use only what the source material says; mark anything you infer “Inference:”. Do not fill gaps in the material with invented content.",
  summarization: "Use only facts in the supplied material and cite it. If no source material is in <context>, say what is missing instead of summarising.",
  research: "Lumen has no web access: only sources in <context> are evidence. Never invent sources, URLs or citations; label anything else “General knowledge:”.",
  planning: "Never invent owners, dates or estimates the user did not give; use “TBD”.",
  code_review: "Only report locations (line numbers, function names) that are visible in the supplied code. Distinguish confirmed defects from possible concerns.",
  refactoring: "Keep external behaviour identical; say explicitly if any behaviour could change.",
};

/** Lumen has no web or search tool, so current-information requests get an explicit honesty rule. */
const CURRENT_INFO_RULE =
  "This question may depend on information newer than your training data, and Lumen cannot browse the web. Answer from the sources in <context> if they cover it (cite them). Otherwise give what you know, say as of roughly when, and tell the user to check an up-to-date source (name the kind of source, e.g. the project's release page). Never present possibly outdated facts as current.";

export function buildStrategy(turn: ResolvedTurn, category: TaskCategory, prefs: Preferences, opts: { depth?: Depth; hasWorkflow: boolean; needsCurrentInfo?: boolean }): Strategy {
  const depth = opts.depth ?? prefs.depth;
  const lines: string[] = [];
  const relationRule = RELATION_RULE[turn.relation];
  if (relationRule) lines.push(relationRule);
  if (turn.ambiguous)
    lines.push(
      "The message is too short or vague to answer reliably and there is no earlier turn it could refer to: ask one short clarifying question (offer 2–3 likely interpretations) instead of guessing.",
    );
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
  // Invariants apply with or without a mode workflow, and whatever the depth or hints setting.
  const invariant = INVARIANT_RULE[category];
  if (invariant) lines.push(invariant);
  if (opts.needsCurrentInfo) lines.push(CURRENT_INFO_RULE);
  lines.push(DEPTH_RULE[depth]);
  if (CODE_CATEGORIES.has(category) && !opts.hasWorkflow) lines.push("Separate facts taken from the context (cited) from assumptions you introduce (prefix them “Assumption:”).");
  return {
    depth,
    hintsOnly,
    instruction: lines.join("\n"),
    label: [RELATION_LABELS[turn.relation], TASK_LABELS[category], hintsOnly ? "Hints" : DEPTH_LABELS[depth]].join(" · "),
  };
}
