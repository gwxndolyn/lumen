// Command registry for the palette. Commands are built from the live app state so only actions
// that exist *and* apply right now are listed. Pure logic (fuzzy match, ranking) is exported for
// tests; execution goes through real `api` calls.

export interface Command {
  id: string;
  title: string;
  /** Group label shown in the palette. */
  section: "Session" | "Navigate" | "Assistant" | "Capture" | "Settings" | "Help";
  /** Extra words that should match (synonyms). */
  keywords?: string;
  /** Platform-formatted shortcut, shown for reference. */
  shortcut?: string;
  run: () => void | Promise<unknown>;
}

/**
 * Subsequence fuzzy score: every query character must appear in order. Rewards matches at word
 * starts and consecutive runs; returns null when it doesn't match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s/·:-]/.test(t[found - 1]!);
    run = found === ti ? run + 1 : 0;
    score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(3, (found - ti) * 0.1);
    ti = found + 1;
  }
  // Prefer shorter titles for equal matches.
  return score - t.length * 0.01;
}

export function rankCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands;
  return commands
    .map((c) => {
      const s = Math.max(fuzzyScore(query, c.title) ?? -Infinity, (fuzzyScore(query, `${c.keywords ?? ""} ${c.section}`) ?? -Infinity) - 2);
      return { c, s };
    })
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/**
 * Wrap a runner so a command can't fire twice while it is still running or within `windowMs`
 * (Enter + click, key repeat, overlapping shortcut and palette).
 */
export function onceGuard(windowMs = 400, now: () => number = Date.now) {
  let busyUntil = 0;
  let running = false;
  return async (fn: () => void | Promise<unknown>) => {
    const t = now();
    if (running || t < busyUntil) return false;
    running = true;
    busyUntil = t + windowMs;
    try {
      await fn();
    } finally {
      running = false;
    }
    return true;
  };
}
