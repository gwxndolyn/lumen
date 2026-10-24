// Read-only Git information for a project. Only the subcommands in READ_ONLY can run; there is no
// code path here that commits, pushes, resets, cleans, stashes, checks out or rebases. Output is
// shown as Git reported it.

import { execFile } from "node:child_process";
import { childEnv } from "./runner";
import { realRoot } from "./boundary";

const READ_ONLY = new Set(["rev-parse", "status", "log", "diff", "branch", "remote", "ls-files", "show"]);
/** Flags that would make a read-only subcommand write or run something. */
const FORBIDDEN_FLAGS = /^--(output|exec|ext-diff|upload-pack|receive-pack)|^-o$|^--no-index$/;

export function gitArgsAllowed(args: string[]): boolean {
  const sub = args.find((a) => !a.startsWith("-"));
  return !!sub && READ_ONLY.has(sub) && !args.some((a) => FORBIDDEN_FLAGS.test(a)) && !(sub === "branch" && args.some((a) => /^-[dDmMcC]$|^--(delete|move|copy|set-upstream)/.test(a)));
}

function git(cwd: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string; err: string }> {
  if (!gitArgsAllowed(args)) return Promise.reject(new Error(`Refused non-read-only git command: ${args[0]}`));
  return new Promise((resolve) => {
    // -c core.fsmonitor/hooksPath: never let a repository's config run programs during a read.
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "--no-pager", ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr || (error as Error | null)?.message || "") }),
    );
  });
}

export interface GitStatus {
  available: boolean;
  /** Why there is no Git information (not a repo, git not installed, …). */
  reason: string | null;
  branch: string | null;
  head: string | null;
  ahead: number | null;
  behind: number | null;
  files: { path: string; index: string; worktree: string; untracked: boolean }[];
  recent: { hash: string; subject: string; author: string; date: string }[];
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const empty: GitStatus = { available: false, reason: null, branch: null, head: null, ahead: null, behind: null, files: [], recent: [] };
  let cwd: string;
  try {
    cwd = realRoot(root);
  } catch (e) {
    return { ...empty, reason: (e as Error).message };
  }
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch((e) => ({ ok: false, out: "", err: String(e) }));
  if (!inside.ok || inside.out.trim() !== "true")
    return { ...empty, reason: /not found|ENOENT|spawn git/i.test(inside.err) ? "Git is not installed or not on PATH." : "This folder is not a Git repository." };
  const [st, log] = await Promise.all([git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]), git(cwd, ["log", "-n", "10", "--format=%h%x1f%s%x1f%an%x1f%cI"])]);
  const out: GitStatus = { ...empty, available: true };
  for (const line of st.out.split("\n")) {
    if (line.startsWith("# branch.head ")) out.branch = line.slice(14);
    else if (line.startsWith("# branch.oid ")) out.head = line.slice(13, 25);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1]!;
      const p = line.startsWith("2 ") ? line.split("\t")[0]!.split(" ").slice(9).join(" ") : parts.slice(8).join(" ");
      out.files.push({ path: p, index: xy[0]!, worktree: xy[1]!, untracked: false });
    } else if (line.startsWith("? ")) out.files.push({ path: line.slice(2), index: "?", worktree: "?", untracked: true });
  }
  out.recent = log.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split("\x1f");
      return { hash: hash!, subject: subject ?? "", author: author ?? "", date: date ?? "" };
    });
  return out;
}

/** `git diff` for one path (working tree vs HEAD), as Git prints it. Read-only. */
export async function gitDiff(root: string, rel: string): Promise<string | null> {
  const cwd = realRoot(root);
  const r = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", rel]);
  return r.ok ? r.out : null;
}
