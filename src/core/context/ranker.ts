import type { ContextSource } from "../../shared/types";
import { contentHash, tokenize } from "./text";

export interface Candidate {
  id: string;
  kind: ContextSource;
  title: string;
  text: string;
  createdAt: number;
  pinned?: boolean;
  /** Explicitly attached by the user for this session (always considered, not just retrieved). */
  explicit?: boolean;
  /** Base64 image for vision models. */
  image?: { mediaType: "image/png" | "image/jpeg"; data: string };
  suspicious?: boolean;
  /** 0–1 reliability; low-confidence OCR is down-weighted. */
  confidence?: number | null;
  sourceId?: string;
  /**
   * Already judged relevant by an index (FTS/BM25 over the whole corpus). Re-ranking within a tiny
   * candidate set makes IDF meaningless, so retrieved items keep a minimum score.
   */
  retrieved?: boolean;
}

export interface Ranked extends Candidate {
  score: number;
}

const KIND_WEIGHT: Record<ContextSource, number> = {
  screenshot: 1.4,
  ocr: 1.3,
  selected_text: 1.4,
  clipboard: 1.2,
  note: 1.2,
  user_message: 1.0,
  document: 1.0,
  transcript: 1.1,
  knowledge: 0.9,
  history: 0.7,
};

/**
 * Okapi BM25 over the candidate set, combined with kind weight, recency and pin boosts.
 * Explicit items keep a floor score so a user-attached screenshot with no text is never dropped.
 */
export function rankCandidates(query: string, candidates: Candidate[], now = Date.now()): Ranked[] {
  const deduped = dedupe(candidates);
  const q = [...new Set(tokenize(query))];
  const docs = deduped.map((c) => tokenize(`${c.title} ${c.text}`));
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, docs.filter((d) => d.includes(term)).length);
  const k1 = 1.2;
  const b = 0.75;

  const ranked = deduped.map((c, i) => {
    const d = docs[i] ?? [];
    let bm25 = 0;
    for (const term of q) {
      const tf = d.filter((t) => t === term).length;
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgdl)));
    }
    const ageMin = Math.max(0, (now - c.createdAt) / 60_000);
    const recency = 1 / (1 + ageMin / 30); // halves after ~30 minutes
    const reliability = c.confidence == null ? 1 : 0.5 + 0.5 * Math.max(0, Math.min(1, c.confidence));
    let score = (bm25 * KIND_WEIGHT[c.kind] + recency * 0.5) * reliability;
    if (c.pinned) score += 1;
    if (c.explicit) score = Math.max(score, 0.5) + 0.5;
    if (c.retrieved && bm25 > 0) score = Math.max(score, 0.75);
    if (c.image) score += 0.75;
    return { ...c, score };
  });
  return ranked.sort((a, b2) => b2.score - a.score);
}

/** Drop candidates whose normalized text is identical (keeps the pinned / most recent one). */
export function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.image) {
      seen.set(`img:${c.id}`, c);
      continue;
    }
    const key = contentHash(c.text.trim().toLowerCase().replace(/\s+/g, " "));
    const prev = seen.get(key);
    if (!prev || (c.pinned && !prev.pinned) || (!!c.pinned === !!prev.pinned && c.createdAt > prev.createdAt)) {
      seen.set(key, c);
    }
  }
  return [...seen.values()];
}
