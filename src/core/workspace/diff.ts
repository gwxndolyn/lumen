// Line diff for change review (Myers-style LCS on lines, bounded). Produces unified hunks with a
// few lines of context. For very large inputs it falls back to "too large to diff" rather than
// spending unbounded time.

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: Hunk[];
  added: number;
  removed: number;
  tooLarge: boolean;
}

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string, context = 3): FileDiff {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Trim common prefix/suffix so the DP table is only over the changed middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length > MAX_CELLS) return { hunks: [], added: bm.length, removed: am.length, tooLarge: true };
  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const all: DiffLine[] = [];
  for (let k = 0; k < pre; k++) all.push({ kind: "ctx", text: a[k]!, oldNo: k + 1, newNo: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      all.push({ kind: "ctx", text: am[i]!, oldNo: pre + i + 1, newNo: pre + j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      // Deletions before insertions, as unified diffs read.
      all.push({ kind: "del", text: am[i]!, oldNo: pre + i + 1, newNo: null });
      i++;
    } else {
      all.push({ kind: "add", text: bm[j]!, oldNo: null, newNo: pre + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) all.push({ kind: "ctx", text: a[a.length - suf + k]!, oldNo: a.length - suf + k + 1, newNo: b.length - suf + k + 1 });
  // Group into hunks: keep every line within `context` of a change; split where the gap is larger.
  const keep = all.map(() => false);
  all.forEach((l, k) => {
    if (l.kind === "ctx") return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = true;
  });
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  all.forEach((l, k) => {
    if (!keep[k]) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { oldStart: l.oldNo ?? all.slice(k).find((x) => x.oldNo)?.oldNo ?? 1, newStart: l.newNo ?? all.slice(k).find((x) => x.newNo)?.newNo ?? 1, lines: [] };
      hunks.push(cur);
    }
    cur.lines.push(l);
  });
  return { hunks, added: all.filter((l) => l.kind === "add").length, removed: all.filter((l) => l.kind === "del").length, tooLarge: false };
}
