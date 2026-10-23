// Support file a user can attach to a bug report. Technical metadata only: versions, platform,
// health, permission state, timings and the tail of the operational log. It never reads the
// database, so no prompts, answers, transcripts, notes or screenshots can end up in it.

const KEY_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(token|apikey|api_key|authorization|x-api-key|x-goog-api-key)(["'\s:=]+)[^\s"',}]{8,}/gi, "$1$2[REDACTED]"],
  [/\b[A-Fa-f0-9]{40}\b/g, "[REDACTED]"],
];

/** Remove credentials and replace the user's home directory (which contains their name). */
export function scrub(text: string, home: string): string {
  let out = text;
  for (const [re, rep] of KEY_PATTERNS) out = out.replace(re, rep);
  if (home && home.length > 1) {
    const variants = [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\"), JSON.stringify(home).slice(1, -1)];
    for (const v of new Set(variants)) out = out.split(v).join("~");
  }
  return out;
}

export interface SupportInput {
  diagnostics: Record<string, unknown>;
  logText: string;
  home: string;
  now: Date;
  maxLogLines?: number;
}

export function buildSupportBundle(i: SupportInput): string {
  const lines = i.logText.split("\n").filter(Boolean);
  const tail = lines.slice(-(i.maxLogLines ?? 400));
  const body = {
    kind: "lumen-support-bundle",
    generatedAt: i.now.toISOString(),
    contains:
      "App version, platform, provider health, permission state, timings, shortcut registration and the last operational log lines. No conversations, transcripts, notes, documents, screenshots or API keys.",
    diagnostics: i.diagnostics,
    log: { totalLines: lines.length, included: tail.length, lines: tail },
  };
  return scrub(JSON.stringify(body, null, 2), i.home);
}
