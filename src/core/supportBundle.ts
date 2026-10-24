import { redactCredentials, redactHome } from "./credentials";

// Support file a user can attach to a bug report. Technical metadata only: versions, platform,
// health, permission state, timings and the tail of the operational log. It never reads the
// database, so no prompts, answers, transcripts, notes or screenshots can end up in it.

/** Remove credentials and replace the user's home directory (which contains their name). */
export function scrub(text: string, home: string): string {
  return redactHome(redactCredentials(text), home);
}

export interface SupportInput {
  diagnostics: Record<string, unknown>;
  logText: string;
  home: string;
  now: Date;
  maxLogLines?: number;
  /** Only log lines at or after this time are included (lines without a parseable time are dropped). */
  sinceMs?: number;
  /** Hard cap on the file size; the oldest log lines are dropped first to meet it. */
  maxBytes?: number;
}

export const SUPPORT_MAX_BYTES = 512 * 1024;

export function buildSupportBundle(i: SupportInput): string {
  let lines = i.logText.split("\n").filter(Boolean);
  const total = lines.length;
  if (i.sinceMs != null) {
    const since = i.sinceMs;
    lines = lines.filter((l) => {
      const m = /"t":"([^"]+)"/.exec(l);
      const at = m ? Date.parse(m[1]!) : NaN;
      return Number.isFinite(at) && at >= since;
    });
  }
  let tail = lines.slice(-(i.maxLogLines ?? 400));
  const max = i.maxBytes ?? SUPPORT_MAX_BYTES;
  const render = () =>
    scrub(
      JSON.stringify(
        {
          kind: "lumen-support-bundle",
          generatedAt: i.now.toISOString(),
          contains:
            "App version, platform, provider health, permission state, timings, shortcut registration and recent operational log lines. No conversations, transcripts, notes, documents, screenshots or API keys.",
          window: i.sinceMs != null ? { since: new Date(i.sinceMs).toISOString() } : null,
          diagnostics: i.diagnostics,
          log: { totalLines: total, inWindow: lines.length, included: tail.length, lines: tail },
        },
        null,
        2,
      ),
      i.home,
    );
  let out = render();
  while (Buffer.byteLength(out) > max && tail.length) {
    tail = tail.slice(Math.ceil(tail.length / 4));
    out = render();
  }
  if (Buffer.byteLength(out) > max) throw new Error("Diagnostics are larger than the support-file limit.");
  return out;
}
