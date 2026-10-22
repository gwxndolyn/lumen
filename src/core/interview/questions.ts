// Live interview-question detection over finalized transcript segments.
//
// Design: only *finalized* segments are considered (never interim text). A question is a run of
// consecutive segments from one speaker that ends with a question mark or opens with an
// interrogative / request phrase ("tell me about…", "walk me through…"). We wait for a short
// silence after the last segment (debounce) so a multi-sentence question is captured whole, and we
// suppress near-duplicates (the interviewer repeating or rephrasing) by token overlap.

import type { TranscriptSegment } from "../../shared/types";

export type QuestionCategory =
  | "introduction"
  | "behavioral"
  | "project"
  | "technical"
  | "coding"
  | "system_design"
  | "product"
  | "tradeoff"
  | "experience"
  | "other";

export const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  introduction: "Introduction & background",
  behavioral: "Behavioral",
  project: "Project deep dive",
  technical: "Technical fundamentals",
  coding: "Coding & algorithms",
  system_design: "System design",
  product: "Product & analytical",
  tradeoff: "Trade-offs & decisions",
  experience: "Previous experience",
  other: "General",
};

export interface DetectedQuestion {
  id: string;
  text: string;
  category: QuestionCategory;
  /** Classification confidence 0–1 (keyword evidence, not a model score). */
  confidence: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  segmentIds: string[];
}

const OPENERS =
  /^(what|why|how|when|where|which|who|whom|whose|can|could|would|will|should|do|does|did|is|are|was|were|have|has|had|tell me|walk me|describe|explain|talk (me )?(through|about)|give me|share|imagine|suppose|design|implement|write|how would|what would|what's|what is|let's say)\b/i;
const QUESTION_MARK = /\?\s*$/;
/** Statements that end with "?" but are not real questions worth answering. */
const NOISE = /^(right|okay|ok|yeah|yes|no|sorry|pardon|huh|really|you know|make sense|does that make sense|can you hear me|am i audible|is that clear|any questions( for me)?|sounds good)\??$/i;

const RULES: [QuestionCategory, RegExp][] = [
  ["introduction", /\b(tell me about yourself|introduce yourself|walk me through your (resume|background|cv)|your background|why (do you want|are you interested|this (company|role))|why should we hire)\b/i],
  ["behavioral", /\b(tell me about a time|describe a (time|situation)|give me an example|a time when|conflict|disagree|failure|failed|mistake|difficult (person|colleague|situation)|proud|challenge you faced|leadership|feedback|deadline|pressure)\b/i],
  ["system_design", /\b(design (a|an|the)|system design|scale|scalab|architecture|distributed|load balanc|sharding|cach(e|ing) layer|throughput|availability|consistency|rate limiter|url shortener|million users|microservice)\b/i],
  ["coding", /\b(algorithm|complexity|big o|o\(n|array|linked list|binary tree|graph|dynamic programming|recursion|sort(ing)?|hash ?map|leetcode|implement a function|write (a |some )?(function|code|program)|reverse a|two sum|substring|palindrome)\b/i],
  ["project", /\b(walk me through (a|the|your) project|project you|you built|your (role|contribution) (in|on)|deep dive|most (interesting|impactful) project|on your resume)\b/i],
  ["tradeoff", /\b(trade-?offs?|pros and cons|why did you (choose|pick|use)|alternatives?|versus|vs\.?|instead of|would you choose)\b/i],
  ["product", /\b(metric|kpi|how would you measure|estimate|how many|market|user(s)? (want|need)|prioriti[sz]e|roadmap|launch|product)\b/i],
  ["experience", /\b(previous (role|job|company)|current role|at your last|in your experience|have you (ever )?(worked|used)|years of experience|responsibilit)\b/i],
  ["technical", /\b(what is|what are|explain|difference between|how does|how do .* work|what happens when|define)\b/i],
];

export function classifyQuestion(text: string): { category: QuestionCategory; confidence: number } {
  for (const [cat, re] of RULES) {
    const m = text.match(re);
    if (m) return { category: cat, confidence: Math.min(0.95, 0.6 + m[0].length / 60) };
  }
  return { category: "other", confidence: 0.3 };
}

export function isQuestionText(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || NOISE.test(t)) return false;
  const words = t.split(/\s+/).length;
  if (words < 3) return false;
  return QUESTION_MARK.test(t) || OPENERS.test(t);
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
}

/** Jaccard similarity of content words. */
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DetectorOptions {
  /** Silence after the last segment before a question is considered complete. */
  debounceMs: number;
  /** Max gap between segments that are still part of the same question. */
  joinGapMs: number;
  /** Questions this similar to a recent one are suppressed as repeats. */
  duplicateThreshold: number;
  /** Who to treat as the interviewer: "remote" (system audio channel), a speaker label, or any. */
  interviewer: "remote" | "any" | string;
  now?: () => number;
}

export const DEFAULT_DETECTOR: DetectorOptions = { debounceMs: 1400, joinGapMs: 2500, duplicateThreshold: 0.72, interviewer: "any" };

/**
 * Incremental detector. Feed every finalized segment with `push()`, then call `poll()` (e.g. on a
 * timer); `poll()` returns at most one newly completed, non-duplicate question.
 */
export class QuestionDetector {
  private buffer: TranscriptSegment[] = [];
  /** Time the last interviewer segment arrived; null when the buffer is known to be complete. */
  private lastAt: number | null = null;
  private recent: { text: string; at: number }[] = [];
  private seen = new Set<string>();
  private readonly opts: DetectorOptions;

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.opts = { ...DEFAULT_DETECTOR, ...opts };
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private fromInterviewer(s: TranscriptSegment): boolean {
    const who = this.opts.interviewer;
    if (who === "any") return s.channel !== "mic" || !s.speaker?.startsWith("You");
    if (who === "remote") return s.channel === "system";
    return s.speaker === who;
  }

  push(seg: TranscriptSegment) {
    if (this.seen.has(seg.id)) return; // duplicate delivery
    this.seen.add(seg.id);
    if (!this.fromInterviewer(seg)) {
      // The candidate started answering: whatever was buffered is complete.
      this.lastAt = null;
      return;
    }
    const prev = this.buffer.at(-1);
    if (prev && (seg.startMs - prev.endMs > this.opts.joinGapMs || prev.speaker !== seg.speaker)) this.buffer = [];
    this.buffer.push(seg);
    if (this.buffer.length > 8) this.buffer.shift();
    this.lastAt = this.now();
  }

  /** Returns a completed question, if the debounce window has passed. */
  poll(force = false): DetectedQuestion | null {
    if (!this.buffer.length) return null;
    if (!force && this.lastAt !== null && this.now() - this.lastAt < this.opts.debounceMs) return null;
    const segs = this.buffer;
    this.buffer = [];
    // The question is the trailing run of sentences from the first question-like sentence.
    let startIdx = segs.findIndex((s) => isQuestionText(s.text));
    if (startIdx < 0) return null;
    // Include a short lead-in sentence ("Okay, great. So…") only if it is directly attached.
    if (startIdx > 0 && segs[startIdx]!.startMs - segs[startIdx - 1]!.endMs < 600 && segs[startIdx - 1]!.text.length < 80) startIdx--;
    const parts = segs.slice(startIdx);
    const text = parts.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ");
    // Duplicate / rephrase suppression within the last 3 minutes.
    const cutoff = this.now() - 180_000;
    this.recent = this.recent.filter((r) => r.at >= cutoff);
    if (this.recent.some((r) => similarity(r.text, text) >= this.opts.duplicateThreshold)) return null;
    this.recent.push({ text, at: this.now() });
    const { category, confidence } = classifyQuestion(text);
    return {
      id: parts.map((p) => p.id).join("+"),
      text,
      category,
      confidence,
      startMs: parts[0]!.startMs,
      endMs: parts.at(-1)!.endMs,
      speaker: parts[0]!.speaker,
      segmentIds: parts.map((p) => p.id),
    };
  }

  reset() {
    this.buffer = [];
    this.recent = [];
    this.seen.clear();
    this.lastAt = null;
  }
}
