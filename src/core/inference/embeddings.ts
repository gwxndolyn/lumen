// Optional semantic knowledge search with a local embedding model (via Ollama). Keyword search
// (FTS5) stays the default and the fallback. The index records model and dimensions; vectors from
// a different model are never mixed in, and changing the model requires an explicit rebuild.

import type { KnowledgeHit } from "../../shared/types";
import type { OllamaRuntime } from "../providers/ollama";
import type { Store } from "../storage/db";

export interface EmbeddingIndexState {
  model: string | null;
  dims: number | null;
  indexed: number;
  totalChunks: number;
  /** The configured model differs from the one the index was built with. */
  stale: boolean;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class EmbeddingIndex {
  constructor(
    private readonly store: Store,
    private readonly runtime: () => OllamaRuntime | null,
  ) {}

  state(configuredModel: string): EmbeddingIndexState {
    const info = this.store.embeddingIndexInfo();
    const cur = info[0] ?? null;
    return {
      model: cur?.model ?? null,
      dims: cur?.dims ?? null,
      indexed: info.reduce((s, x) => s + x.chunks, 0),
      totalChunks: this.store.countChunks(),
      stale: !!cur && (cur.model !== configuredModel || info.length > 1),
    };
  }

  /**
   * Embed knowledge chunks that have no vector yet. Runs only when the user asks (Rebuild / Update),
   * in batches; returns how many were added. Rebuild clears the index first.
   */
  async build(model: string, opts: { rebuild?: boolean; signal?: AbortSignal; batch?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
    const rt = this.runtime();
    if (!rt) throw new Error("No local runtime is configured.");
    if (!model) throw new Error("Choose a local embedding model first.");
    const details = await rt.show(model);
    if (!details.capabilities.includes("embedding")) throw new Error(`“${model}” is not an embedding model. Install one with, for example: ollama pull nomic-embed-text`);
    const st = this.state(model);
    if (opts.rebuild || st.stale) this.store.clearEmbeddings();
    const total = this.store.countChunks();
    let done = this.state(model).indexed;
    let added = 0;
    const batch = opts.batch ?? 32;
    for (;;) {
      if (opts.signal?.aborted) break;
      const todo = this.store.chunksWithoutEmbedding(model, batch);
      if (!todo.length) break;
      const { vectors } = await rt.embed(
        model,
        todo.map((t) => t.text),
        opts.signal,
      );
      this.store.saveEmbeddings(
        model,
        todo.map((t, i) => ({ chunkId: t.id, vector: Float32Array.from(vectors[i]!) })),
      );
      added += todo.length;
      done += todo.length;
      opts.onProgress?.(done, total);
    }
    return added;
  }

  /** Top-k chunks by cosine similarity. Returns null (→ use keyword search) when unusable. */
  async search(model: string, query: string, sessionId: string | null, k = 6, signal?: AbortSignal): Promise<KnowledgeHit[] | null> {
    const rt = this.runtime();
    const st = this.state(model);
    if (!rt || !model || st.stale || !st.indexed) return null;
    let q: Float32Array;
    try {
      const { vectors } = await rt.embed(model, [query], signal, 5000);
      q = Float32Array.from(vectors[0]!);
    } catch {
      return null;
    }
    if (q.length !== st.dims) return null;
    const scored = this.store
      .embeddingsForScope(model, sessionId)
      .map((r) => ({ r, s: cosine(q, r.vector) }))
      .filter((x) => x.s > 0.35)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    return scored.map(({ r }) => ({ docId: r.docId, chunkId: r.chunkId, title: r.title, text: r.text, snippet: r.text.slice(0, 200), sessionId }));
  }
}

/** Merge semantic and keyword hits (keyword first for exact terms), de-duplicated, bounded. */
export function mergeHits(keyword: KnowledgeHit[], semantic: KnowledgeHit[] | null, k = 6): KnowledgeHit[] {
  if (!semantic) return keyword.slice(0, k);
  const seen = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const h of [...keyword.slice(0, Math.ceil(k / 2)), ...semantic, ...keyword]) {
    if (seen.has(h.chunkId)) continue;
    seen.add(h.chunkId);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}
