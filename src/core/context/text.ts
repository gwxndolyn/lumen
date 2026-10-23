import { createHash } from "node:crypto";

/** Normalize untrusted text: NFC, strip control chars (except \n\t), collapse runs of blank lines. */
export function normalizeText(input: string): string {
  return (
    input
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      // Control chars, zero-width chars and bidi overrides (common in hidden-text injection).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function contentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your me my we our can do does".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split text into roughly `size`-char chunks on paragraph/sentence boundaries, with overlap. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  if (text.length <= size) return text.length ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (breakAt > size * 0.5) end = start + breakAt + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

/**
 * Shrink an oversized item to `max` chars by keeping its opening (orientation) plus the paragraphs
 * that best match the question, in their original order, with gaps marked. Without this, a
 * relevant passage past the per-item cap would silently never reach the model.
 * Returns the text unchanged when it already fits.
 */
export function relevantExcerpt(text: string, query: string, max: number): { text: string; excerpted: boolean } {
  if (text.length <= max) return { text, excerpted: false };
  const terms = [...new Set(tokenize(query))];
  const head = Math.min(Math.floor(max * 0.2), 2000);
  const chunks = chunkText(text.slice(head), 800, 0);
  if (!terms.length || !chunks.length) return { text: `${truncate(text, max)}\n[truncated]`, excerpted: true };
  const scored = chunks.map((c, i) => {
    const toks = tokenize(c);
    let s = 0;
    for (const t of terms) s += toks.filter((x) => x === t).length > 0 ? 1 : 0;
    return { i, c, s };
  });
  const picked = new Set<number>();
  let used = head;
  for (const p of [...scored].filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (used + p.c.length + 8 > max) continue;
    picked.add(p.i);
    used += p.c.length + 8;
  }
  if (!picked.size) return { text: `${truncate(text, max)}\n[truncated]`, excerpted: true };
  const parts = [text.slice(0, head).trimEnd()];
  let prev = -1;
  for (const p of scored) {
    if (!picked.has(p.i)) continue;
    if (p.i !== prev + 1) parts.push("[…]");
    parts.push(p.c);
    prev = p.i;
  }
  if (prev !== scored.length - 1) parts.push("[…]");
  return { text: parts.join("\n"), excerpted: true };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
