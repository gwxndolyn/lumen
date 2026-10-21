// Prompt-injection hardening for untrusted context (screen text, documents, transcripts).
//
// Detection here is a heuristic used only to *warn* the user and annotate the context block.
// The real defence is structural: untrusted content is always placed inside a delimited data
// block in the user turn, never in the system prompt, and the model has no tools — so even a
// successful injection cannot trigger privileged actions.

const PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /disregard (all |any |the )?(previous|prior|above|system) (instructions|prompts|rules)/i,
  /you are now (a|an|in) /i,
  /new (system )?instructions?:/i,
  /\bsystem prompt\b/i,
  /reveal (your|the) (system|hidden|secret) (prompt|instructions)/i,
  /<\/?\s*(system|assistant|instructions?)\s*>/i,
  /\bdeveloper mode\b/i,
  /do not (tell|inform) the user/i,
  /(run|execute) (this|the following) (command|code|script)/i,
];

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((p) => p.test(text));
}

/**
 * Neutralize anything that could close or open our delimiter tags. We only need to protect the
 * `<source ...>` / `</source>` envelope; everything else is passed through verbatim.
 */
export function escapeForEnvelope(text: string): string {
  return text.replace(/<(\/?)\s*(source|context|question)\b/gi, "‹$1$2");
}

export function escapeAttr(text: string): string {
  return text.replace(/[<>"&\n\r]/g, (c) => ({ "<": "‹", ">": "›", '"': "'", "&": "+", "\n": " ", "\r": " " })[c] ?? "");
}
