// Response planning for one chat turn: resolve how the message relates to the conversation,
// classify the task, and choose a response strategy. Pure and deterministic (no provider call), so
// it adds no latency or cost and never blocks ordinary chat: any failure falls back to a plain plan.

import type { AnswerStyle, ChatMessage, Settings } from "../../shared/types";
import { LANGUAGES, type Language } from "../technical/problem";
import { classifyTask, type Classification } from "./classify";
import { buildStrategy, preferencesBlock, type Depth, type Strategy } from "./strategy";
import { resolveTurn, type PriorTurn, type ResolvedTurn } from "./turns";

export interface ResponsePlan {
  turn: ResolvedTurn;
  task: Classification;
  strategy: Strategy;
  preferences: string;
  /** How many prior messages of this conversation to send as history. */
  historyMessages: number;
}

export interface PlanInput {
  question: string;
  /** Messages of the current conversation before this question (oldest first). */
  history: ChatMessage[];
  settings: Settings;
  sessionType: string;
  style: AnswerStyle;
  depth?: Depth;
  hasScreen: boolean;
  codeInContext: boolean;
  /** A mode workflow (interview / technical) already supplies the answer structure. */
  hasWorkflow: boolean;
}

const FULL_HISTORY = 12;
/** A new, unrelated question keeps only the last exchange, so stale topics don't steer the answer. */
const NEW_TOPIC_HISTORY = 2;

/** Language of the first fenced code block in an answer, if recognizable. */
export function answerLanguage(answer: string): Language | null {
  const fence = /```([\w+#-]+)/.exec(answer)?.[1]?.toLowerCase();
  if (!fence) return null;
  const alias: Record<string, Language> = { py: "python", js: "javascript", ts: "typescript", "c++": "cpp", "c#": "csharp", cs: "csharp", kt: "kotlin", rs: "rust", golang: "go" };
  return LANGUAGES.find((l) => l.fence === fence || l.id === fence)?.id ?? alias[fence] ?? null;
}

/** Most recent completed question/answer pair in the conversation. */
export function priorTurn(history: ChatMessage[]): PriorTurn | null {
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i]!;
    const q = history[i - 1]!;
    if (a.role === "assistant" && q.role === "user" && !a.meta.cancelled && !a.meta.interrupted && a.content.trim()) {
      return { question: q.content, answer: a.content, task: a.meta.intent?.category ?? null, language: answerLanguage(a.content) };
    }
  }
  return null;
}

export function depthFor(style: AnswerStyle, requested: Depth | undefined, preferred: Depth): Depth {
  if (requested) return requested;
  // The explicit "Detailed explanation" style asks for depth; other styles keep the preference.
  return style === "detailed" ? "deep" : preferred;
}

export function planResponse(input: PlanInput): ResponsePlan {
  const p = input.settings.personalization;
  const prefs = {
    depth: p.depth,
    language: input.settings.technical.language,
    alsoKnows: p.alsoKnows,
    level: input.settings.technical.level,
    codeStyle: p.codeStyle,
    hintsFirst: p.hintsFirst,
    includeComplexity: p.includeComplexity,
    includeTests: p.includeTests,
  };
  const prior = priorTurn(input.history);
  const turn = resolveTurn(input.question, prior, { hasScreen: input.hasScreen });
  // Classify follow-ups by what they refer to as well ("what about iterative?" → the tree problem).
  const classifyText = turn.anchor && turn.relation !== "new" ? `${turn.anchor.question}\n${input.question}` : input.question;
  let task: Classification;
  try {
    task = classifyTask(classifyText, { sessionType: input.sessionType, codeInContext: input.codeInContext });
  } catch {
    task = { category: "general", confidence: 0 };
  }
  const strategy = buildStrategy(turn, task.category, prefs, { depth: depthFor(input.style, input.depth, p.depth), hasWorkflow: input.hasWorkflow });
  return {
    turn,
    task,
    strategy,
    preferences: preferencesBlock(prefs),
    historyMessages: turn.relation === "new" ? NEW_TOPIC_HISTORY : FULL_HISTORY,
  };
}
