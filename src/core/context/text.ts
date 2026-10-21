import { createHash } from "node:crypto";

/** Normalize untrusted text: NFC, strip control chars (except \n\t), collapse runs of blank lines. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // Control chars, zero-width chars and bidi overrides (common in hidden-text injection).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your me my we our can do does".split(
    " ",
  ),
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

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
