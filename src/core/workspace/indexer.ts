// Incremental file index for one project root. In memory (rebuilt cheaply on open), bounded by
// file count, file size and time. Stores paths, sizes, mtimes and content fingerprints; text is
// read on demand for search, never kept for the whole repository.
//
// Excluded: generated/vendor directories, .gitignore matches (a practical subset: literal names,
// "dir/", leading "/", "*" and "**" globs, "!" negation), user-configured exclusions, binary files,
// files above the size cap, and protected files (credentials/keys — see boundary.ts). Symlinks
// are not followed.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProtected } from "./boundary";

export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "release",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".DS_Store",
  "dist-electron",
  "dist-renderer",
];

export interface IndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxMs: number;
}
export const DEFAULT_INDEX_LIMITS: IndexLimits = { maxFiles: 20_000, maxFileBytes: 1_000_000, maxMs: 15_000 };

export interface IndexedFile {
  rel: string;
  size: number;
  mtimeMs: number;
  /** sha256 of the content (first 16 hex chars). Null for files above the size cap. */
  hash: string | null;
  binary: boolean;
}

export interface IndexState {
  status: "idle" | "indexing" | "ready" | "partial" | "failed";
  files: number;
  skipped: { protected: number; ignored: number; large: number; binary: number; unreadable: number };
  startedAt: number | null;
  finishedAt: number | null;
  /** Why the last run stopped early (limits) or failed. */
  note: string | null;
}

/** Convert one .gitignore line to a matcher over project-relative paths. */
export function gitignoreMatcher(lines: string[]): (rel: string, isDir: boolean) => boolean {
  const rules = lines
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((raw) => {
      const negate = raw.startsWith("!");
      let p = negate ? raw.slice(1) : raw;
      const dirOnly = p.endsWith("/");
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.startsWith("/") || p.includes("/");
      p = p.replace(/^\//, "");
      const re = new RegExp(
        `^${anchored ? "" : "(?:.*/)?"}${p
          .split("**")
          .map((seg) =>
            seg
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]"),
          )
          .join(".*")}(?:/.*)?$`,
      );
      return { re, negate, dirOnly };
    });
  return (rel, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(rel.split("/").slice(0, -1).join("/"))) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function fingerprint(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class ProjectIndex {
  private files = new Map<string, IndexedFile>();
  state: IndexState = { status: "idle", files: 0, skipped: { protected: 0, ignored: 0, large: 0, binary: 0, unreadable: 0 }, startedAt: null, finishedAt: null, note: null };
  private cancelled = false;

  constructor(
    private readonly root: string,
    private readonly excludes: string[] = [],
    private readonly limits: IndexLimits = DEFAULT_INDEX_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  cancel() {
    this.cancelled = true;
  }

  /**
   * (Re)scan the tree. Files whose size and mtime are unchanged keep their previous fingerprint,
   * so a rescan reads only what changed. Deleted files drop out. Stops (status "partial") at the
   * file-count or time limit instead of running unbounded.
   */
  refresh(): IndexState {
    this.cancelled = false;
    const started = this.now();
    const skipped = { protected: 0, ignored: 0, large: 0, binary: 0, unreadable: 0 };
    this.state = { ...this.state, status: "indexing", startedAt: started, note: null };
    let ignore: (rel: string, isDir: boolean) => boolean = () => false;
    try {
      ignore = gitignoreMatcher(fs.readFileSync(path.join(this.root, ".gitignore"), "utf8").split("\n"));
    } catch {
      /* no .gitignore */
    }
    const userIgnore = gitignoreMatcher(this.excludes);
    const next = new Map<string, IndexedFile>();
    const stack = [""];
    let stopped: string | null = null;
    try {
      while (stack.length) {
        if (this.cancelled) {
          stopped = "Indexing was cancelled.";
          break;
        }
        if (this.now() - started > this.limits.maxMs) {
          stopped = `Stopped after ${Math.round(this.limits.maxMs / 1000)} s; some files are not indexed.`;
          break;
        }
        const dirRel = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(this.root, dirRel), { withFileTypes: true });
        } catch {
          skipped.unreadable++;
          continue;
        }
        for (const e of entries) {
          const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
          if (e.isSymbolicLink()) {
            skipped.ignored++;
            continue;
          }
          const isDir = e.isDirectory();
          if (DEFAULT_EXCLUDES.includes(e.name) || ignore(rel, isDir) || userIgnore(rel, isDir)) {
            skipped.ignored++;
            continue;
          }
          if (isProtected(rel)) {
            skipped.protected++;
            continue;
          }
          if (isDir) {
            stack.push(rel);
            continue;
          }
          if (!e.isFile()) continue;
          if (next.size >= this.limits.maxFiles) {
            stopped = `Indexed the first ${this.limits.maxFiles.toLocaleString()} files; add exclusions in project settings to index the rest.`;
            stack.length = 0;
            break;
          }
          let st: fs.Stats;
          try {
            st = fs.statSync(path.join(this.root, rel));
          } catch {
            skipped.unreadable++;
            continue;
          }
          const prev = this.files.get(rel);
          if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
            next.set(rel, prev);
            continue;
          }
          if (st.size > this.limits.maxFileBytes) {
            skipped.large++;
            next.set(rel, { rel, size: st.size, mtimeMs: st.mtimeMs, hash: null, binary: false });
            continue;
          }
          try {
            const buf = fs.readFileSync(path.join(this.root, rel));
            const binary = looksBinary(buf);
            if (binary) skipped.binary++;
            next.set(rel, { rel, size: st.size, mtimeMs: st.mtimeMs, hash: fingerprint(buf), binary });
          } catch {
            skipped.unreadable++;
          }
        }
      }
      this.files = next;
      this.state = { status: stopped ? "partial" : "ready", files: next.size, skipped, startedAt: started, finishedAt: this.now(), note: stopped };
    } catch (err) {
      this.state = { ...this.state, status: "failed", finishedAt: this.now(), note: (err as Error).message };
    }
    return this.state;
  }

  get(rel: string): IndexedFile | undefined {
    return this.files.get(rel);
  }

  list(): IndexedFile[] {
    return [...this.files.values()];
  }

  /** Fingerprint of several files as they are on disk now (re-read; never trusts the index). */
  currentFingerprint(rels: string[]): string {
    const parts = [...new Set(rels)].sort().map((r) => {
      try {
        return `${r}:${fingerprint(fs.readFileSync(path.join(this.root, r)))}`;
      } catch {
        return `${r}:missing`;
      }
    });
    return fingerprint(parts.join("\n"));
  }

  /** Fingerprint of every indexed text file — "has anything in the project changed?". */
  treeFingerprint(): string {
    return fingerprint(
      this.list()
        .filter((f) => !f.binary)
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .map((f) => `${f.rel}:${f.hash ?? f.size}`)
        .join("\n"),
    );
  }

  /**
   * Search filenames and file contents. Contents are read on demand, at most `maxScan` text files,
   * and matched line by line (case-insensitive substring). Symbols: a definition-shaped match
   * ("function foo", "class Foo", "def foo", "const foo =") ranks first.
   */
  search(query: string, opts: { limit?: number; maxScan?: number } = {}): { rel: string; line: number | null; text: string; kind: "name" | "definition" | "content" }[] {
    const q = query.trim().toLowerCase();
    if (!q || q.length > 200) return [];
    const limit = opts.limit ?? 50;
    const out: { rel: string; line: number | null; text: string; kind: "name" | "definition" | "content" }[] = [];
    for (const f of this.files.values()) if (f.rel.toLowerCase().includes(q)) out.push({ rel: f.rel, line: null, text: f.rel, kind: "name" });
    const defRe = new RegExp(`\\b(function|class|def|interface|type|enum|struct|fn|func|const|let|var)\\s+${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    let scanned = 0;
    for (const f of this.files.values()) {
      if (f.binary || f.hash === null) continue;
      if (++scanned > (opts.maxScan ?? 5000)) break;
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.root, f.rel), "utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(q)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && out.length < limit * 3; i++) {
        if (!lines[i]!.toLowerCase().includes(q)) continue;
        out.push({ rel: f.rel, line: i + 1, text: lines[i]!.trim().slice(0, 200), kind: defRe.test(lines[i]!) ? "definition" : "content" });
      }
    }
    const order = { definition: 0, name: 1, content: 2 } as const;
    return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, limit);
  }
}
