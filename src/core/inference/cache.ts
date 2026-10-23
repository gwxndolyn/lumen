// Bounded LRU caches with TTL. Nothing here is persisted: response text can contain sensitive
// context, so it lives in memory for minutes and is dropped on restart, "Delete everything",
// session deletion, or when the user clears it.

import { createHash } from "node:crypto";

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  /** Median time a hit saved versus the original request, when measured. */
  savedMsP50: number | null;
}

export class LruCache<V> {
  private map = new Map<string, { value: V; expiresAt: number; bytes: number; tag: string | null; costMs: number | null }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private saved: number[] = [];

  constructor(
    private readonly opts: { maxEntries: number; maxBytes: number; ttlMs: number; size: (v: V) => number },
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e || e.expiresAt <= this.now()) {
      if (e) this.remove(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    if (e.costMs != null) {
      this.saved.push(e.costMs);
      if (this.saved.length > 200) this.saved.shift();
    }
    return e.value;
  }

  set(key: string, value: V, opts: { tag?: string | null; costMs?: number | null } = {}) {
    const bytes = this.opts.size(value);
    if (bytes > this.opts.maxBytes) return;
    if (this.map.has(key)) this.remove(key);
    this.map.set(key, { value, expiresAt: this.now() + this.opts.ttlMs, bytes, tag: opts.tag ?? null, costMs: opts.costMs ?? null });
    this.bytes += bytes;
    while (this.map.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.map.keys().next().value!;
      this.remove(oldest);
      this.evictions++;
    }
  }

  private remove(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    this.bytes -= e.bytes;
    this.map.delete(key);
  }

  /** Drop every entry with this tag (e.g. a session id). */
  invalidateTag(tag: string): number {
    let n = 0;
    for (const [k, e] of this.map) {
      if (e.tag !== tag) continue;
      this.remove(k);
      n++;
    }
    return n;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats(): CacheStats {
    const s = [...this.saved].sort((a, b) => a - b);
    return { entries: this.map.size, bytes: this.bytes, hits: this.hits, misses: this.misses, evictions: this.evictions, savedMsP50: s.length ? s[Math.floor(s.length / 2)]! : null };
  }
}

/** Stable key over everything that changes an answer: provider, model, every system block, every message, limits. */
export function responseKey(parts: { kind: string; model: string; system: string[]; messages: unknown; maxTokens: number; effort: string }): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export interface CachedResponse {
  text: string;
  model: string;
  stopReason: string;
}
