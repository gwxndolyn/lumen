// Follow-up resolution: decides how the current message relates to the previous turn of the same
// conversation, so "What about the iterative approach?" is answered about the same problem without
// the user repeating it. Deterministic (no model call): cheap, instant and testable.

import type { Language } from "../technical/problem";
import { similarity } from "../interview/questions";

export type TurnRelation = "new" | "follow_up" | "elaborate" | "simplify" | "correction" | "screen" | "revise_code";

export const RELATION_LABELS: Record<TurnRelation, string> = {
  new: "New question",
  follow_up: "Follow-up",
  elaborate: "Elaborate",
  simplify: "Simplify",
  correction: "Correction",
  screen: "About the screen",
  revise_code: "Revise code",
};

export interface PriorTurn {
  question: string;
  answer: string;
  task?: string | null;
  language?: Language | null;
}

export interface ResolvedTurn {
  relation: TurnRelation;
  /** The earlier turn this message builds on (null for a new question). */
  anchor: PriorTurn | null;
  /** What to retrieve context with: follow-ups include the anchor question's terms. */
  retrievalQuery: string;
  /** Programming language explicitly requested in this message, if any. */
  requestedLanguage: Language | null;
  /** Too short or vague to answer reliably on its own; the model should ask one clarifying question. */
  ambiguous: boolean;
}

const LANGUAGE_PATTERNS: [Language, RegExp][] = [
  ["typescript", /\b(typescript|ts)\b/i],
  ["javascript", /\b(javascript|js|node(\.js)?)\b/i],
  ["python", /\bpython\b/i],
  ["java", /\bjava\b(?!script)/i],
  ["kotlin", /\bkotlin\b/i],
  ["cpp", /(\bc\+\+|\bcpp\b)/i],
  ["csharp", /(\bc#|\bc sharp\b|\bcsharp\b|\.net\b)/i],
  ["go", /\b(golang|in go|go version|go code)\b/i],
  ["rust", /\brust\b/i],
  ["sql", /\b(sql|postgres(ql)?|mysql)\b/i],
];

/** A language the user explicitly asks for ("in Java", "convert to C++"). */
export function requestedLanguage(text: string): Language | null {
  for (const [id, re] of LANGUAGE_PATTERNS) if (re.test(text)) return id;
  return null;
}

const SCREEN_REF = /\b(on (my|the) screen|this (code|function|method|class|error|diagram|page|problem|question|output|query|snippet)|what('s| is) (shown|visible|here)|see here|the (code|error|problem) (above|here|shown)|this one|line \d+)\b/i;
const CORRECTION = /^(actually|no[,.!]|nope|not quite|that'?s (wrong|not right|incorrect)|wrong|incorrect|i meant|you assumed|correction)\b|\b(that'?s (wrong|incorrect)|you misunderstood|the constraint is actually|it should (be|return)|i said|not what i asked)\b/i;
const SIMPLIFY = /^(simplify|simpler|in simple(r)? terms|eli5|explain (it )?like i'?m (five|5)|too (long|complicated|complex)|shorter|tl;?dr|summari[sz]e (that|it|this))\b|\b(simpler|more simply|plain english|less jargon)\b/i;
/** References that only make sense with an antecedent ("fix it", "why?"). */
const DANGLING = /^(it|this|that|those|them|why|how|and|so|then|what about it|fix it|do it|again|more|same)\??$/i;
const ELABORATE = /^(why\??|how so\??|explain (that|this|it|more|further)|more (detail|details)|go deeper|elaborate|can you (expand|elaborate)|tell me more|walk me through (it|that|this)|break (it|that) down|in more detail)\b/i;
const REVISE_VERB = /\b(change|modify|update|rewrite|refactor|fix|optimi[sz]e|simplify|convert|translate|port|make|add|remove|rename|handle|support|use)\b/i;
const CODE_REF = /\b(it|that|this|the (code|solution|function|query|implementation|method|loop)|your (code|solution|answer|function))\b/i;
const CONVERT = /\b(rewrite|convert|translate|port|write|redo|show)\b.*\b(in|to|into|using)\b|\binstead\b|\b(version|equivalent)\b/i;
const FOLLOW_UP = /^(what about|how about|and (if|what|how|for)|what if|but (what|how|if|why)|then|so|also|same (but|for|with)|ok(ay)?,? (and|so|what|how))\b|\b(it|that|this|those|them|the same|iterative|recursive|another (way|approach)|other approach|alternative|better approach|space complexity|time complexity|edge cases?|follow-?up)\b/i;

/**
 * Classify the relation of `text` to the previous turn. Without a previous turn everything is new,
 * except a reference to the screen (which needs screen context, not history).
 */
export function resolveTurn(text: string, prior: PriorTurn | null, opts: { hasScreen: boolean }): ResolvedTurn {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const lang = requestedLanguage(t);
  const build = (relation: TurnRelation, ambiguous = false): ResolvedTurn => ({
    relation,
    anchor: relation === "new" || relation === "screen" ? (relation === "screen" ? prior : null) : prior,
    retrievalQuery: relation === "new" || !prior ? t : `${prior.question} ${t}`,
    requestedLanguage: lang,
    ambiguous,
  });
  if (opts.hasScreen && SCREEN_REF.test(t)) return build("screen");
  if (!prior) {
    // Nothing to refer back to: a bare "why?" / "fix it" / one-word input cannot be resolved.
    const vague = DANGLING.test(t) || (words <= 2 && !lang && !/[a-z]{4,}.*[a-z]{4,}/i.test(t) && !/\?$/.test(t));
    return build("new", vague);
  }

  const priorHasCode = /```/.test(prior.answer);
  if (CORRECTION.test(t)) return build("correction");
  // Revising earlier code needs both an editing verb and a reference to that code, or an explicit
  // conversion to another language ("in Java", "Java version") — merely naming a language is not enough.
  const switchesLanguage = !!lang && lang !== prior.language && (CONVERT.test(t) || words <= 4);
  if (priorHasCode && ((REVISE_VERB.test(t) && CODE_REF.test(t)) || switchesLanguage)) return build("revise_code");
  if (SIMPLIFY.test(t) && words <= 14) return build("simplify");
  if (ELABORATE.test(t) && words <= 14) return build("elaborate");
  if (FOLLOW_UP.test(t) && words <= 18) return build("follow_up");
  // Same topic (shared content words) without explicit cue words.
  if (similarity(t, prior.question) >= 0.25) return build("follow_up");
  return build("new");
}
