// Durable project memory: short facts the user explicitly saves (preferences, conventions,
// decisions…). Separate from session history; nothing is saved automatically. Retrieval is
// keyword-based (FTS5/BM25 over the existing SQLite store) — Lumen has no embedding provider.

import type { MemoryItem, MemoryKind, Store } from "../storage/db";
import { classify } from "../context/sensitivity";
import { looksLikeInjection } from "../context/injection";
import { normalizeText } from "../context/text";

export const MEMORY_KINDS: Record<MemoryKind, string> = {
  preference: "Preference",
  convention: "Coding convention",
  architecture: "Architecture",
  decision: "Decision",
  known_issue: "Known issue",
  task: "Open task",
};

export const MAX_MEMORY_CHARS = 600;
export const MAX_MEMORIES = 300;
/** At most this many memories are sent with one question, and at most this many characters. */
export const MEMORY_RETRIEVAL = { items: 5, chars: 1500 };

export class MemoryError extends Error {}

/** Validate a memory before saving: short, not a secret, not a pasted transcript. */
export function validateMemory(text: string): string {
  const t = normalizeText(text).replace(/\s+/g, " ").trim();
  if (!t) throw new MemoryError("The memory is empty.");
  if (t.length > MAX_MEMORY_CHARS) throw new MemoryError(`Keep memories short (at most ${MAX_MEMORY_CHARS} characters). Save longer material as a knowledge document instead.`);
  const cls = classify(t);
  if (cls.sensitivity === "sensitive")
    throw new MemoryError(`This looks like it contains sensitive data (${cls.kinds.join(", ")}). Memories are sent with future questions, so they must not contain secrets.`);
  // Transcript-shaped text ("[00:12] Speaker 1: …") is not a durable fact.
  if (/\[\d{1,2}:\d{2}(:\d{2})?\]/.test(t) && /\b(speaker|remote|you)\b\s*\d*:/i.test(t)) throw new MemoryError("Transcripts are not saved as memory. Save the decision or fact itself.");
  return t;
}

export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  list(): MemoryItem[] {
    return this.store.listMemories(this.now());
  }

  add(kind: MemoryKind, text: string, opts: { sessionId?: string | null; ttlDays?: number | null } = {}): MemoryItem {
    const t = validateMemory(text);
    if (this.store.listMemories(this.now()).length >= MAX_MEMORIES) throw new MemoryError(`Memory is full (${MAX_MEMORIES} items). Delete some before adding more.`);
    const dup = this.list().find((m) => m.text.toLowerCase() === t.toLowerCase());
    if (dup) return dup;
    return this.store.addMemory({ kind, text: t, sessionId: opts.sessionId ?? null, expiresAt: opts.ttlDays ? this.now() + opts.ttlDays * 86_400_000 : null }, this.now());
  }

  update(id: string, patch: { text?: string; kind?: MemoryKind }): MemoryItem {
    const text = patch.text === undefined ? undefined : validateMemory(patch.text);
    const m = this.store.updateMemory(id, { ...patch, text }, this.now());
    if (!m) throw new MemoryError("That memory no longer exists.");
    return m;
  }

  delete(id: string): void {
    if (!this.store.deleteMemory(id)) throw new MemoryError("That memory no longer exists.");
  }

  /**
   * Memories relevant to a question: keyword matches first, then always-relevant preferences and
   * conventions, bounded by count and size. Suspicious text (embedded instructions) is skipped.
   */
  retrieve(query: string): MemoryItem[] {
    const out: MemoryItem[] = [];
    const seen = new Set<string>();
    let chars = 0;
    const take = (m: MemoryItem) => {
      if (seen.has(m.id) || out.length >= MEMORY_RETRIEVAL.items || chars + m.text.length > MEMORY_RETRIEVAL.chars || looksLikeInjection(m.text)) return;
      seen.add(m.id);
      chars += m.text.length;
      out.push(m);
    };
    for (const m of this.store.searchMemories(query, MEMORY_RETRIEVAL.items * 2, this.now())) take(m);
    // Preferences and conventions shape every answer; include the most recent if room remains.
    for (const m of this.list().filter((x) => x.kind === "preference" || x.kind === "convention")) take(m);
    if (out.length)
      this.store.touchMemories(
        out.map((m) => m.id),
        this.now(),
      );
    return out;
  }
}
