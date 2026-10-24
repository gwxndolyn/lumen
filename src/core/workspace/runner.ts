// Command execution for verification (tests, builds, linters). This is the only place Lumen starts
// a process in a user project.
//
// - argv arrays only, never a shell: no pipes, redirection, globbing, `&&` or variable expansion,
//   so a command is exactly what the approval showed.
// - The working directory is the project root (re-resolved now, so a moved root fails).
// - The caller decides whether this command is allowed (project allow-list or a one-time user
//   approval). This module does not check permissions, and is never reachable from model output
//   without that check (see agent.ts / workspace service).
// - Bounded: timeout (SIGTERM, then SIGKILL), output cap, cancellation via AbortSignal.
// - The environment is the user's, minus variables that look like credentials, so a repository
//   script can't read API keys from Lumen's process.

import { spawn } from "node:child_process";
import { realRoot } from "./boundary";

export type RunStatus = "passed" | "failed" | "timed_out" | "cancelled" | "error";

export interface RunResult {
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  startedAt: number;
  finishedAt: number;
  /** Process could not be started (e.g. command not found). */
  error: string | null;
}

export interface RunOptions {
  root: string;
  argv: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onOutput?: (chunk: string) => void;
  now?: () => number;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const KEEP_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "WINDIR",
  "NODE_ENV",
  "TERM",
  "USER",
  "LOGNAME",
]);

export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (KEEP_ENV.has(k.toUpperCase()) || (!SECRET_ENV.test(k) && !k.startsWith("LUMEN_") && !k.startsWith("ELECTRON_"))) out[k] = v;
  }
  return out;
}

/** Validate an argv: non-empty strings, no NULs, bounded. Shell syntax is passed literally (no shell). */
export function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || !argv.length || argv.length > 64) throw new Error("A command is a list of 1–64 arguments.");
  for (const a of argv) if (typeof a !== "string" || !a.length || a.length > 4000 || a.includes("\0")) throw new Error("Invalid command argument.");
  return argv as string[];
}

export function runCommand(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? Date.now;
  const startedAt = now();
  const max = o.maxOutputBytes ?? 200_000;
  return new Promise((resolve) => {
    let cwd: string;
    try {
      cwd = realRoot(o.root);
      validateArgv(o.argv);
    } catch (e) {
      return resolve({ status: "error", exitCode: null, signal: null, output: "", truncated: false, startedAt, finishedAt: now(), error: (e as Error).message });
    }
    if (o.signal?.aborted) return resolve({ status: "cancelled", exitCode: null, signal: null, output: "", truncated: false, startedAt, finishedAt: now(), error: null });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    // Windows resolves .cmd/.bat shims (npm, npx) only through a shell; use it there for those,
    // with arguments quoted, and nowhere else.
    const win = process.platform === "win32";
    const needsShell = win && /^(npm|npx|pnpm|yarn|corepack)$/i.test(o.argv[0]!);
    const child = spawn(
      needsShell ? `${o.argv[0]}.cmd` : o.argv[0]!,
      o.argv.slice(1).map((a) => (needsShell ? `"${a.replace(/"/g, '""')}"` : a)),
      {
        cwd,
        env: childEnv(),
        shell: needsShell,
        windowsHide: true,
        detached: !win, // own process group, so a timeout kills the whole tree
      },
    );
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (!win && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    const append = (b: Buffer) => {
      const s = b.toString("utf8");
      o.onOutput?.(s);
      if (output.length >= max) {
        truncated = true;
        return;
      }
      output += s.slice(0, max - output.length);
      if (output.length >= max) truncated = true;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, o.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: Omit<RunResult, "startedAt" | "finishedAt" | "output" | "truncated">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ ...r, output, truncated, startedAt, finishedAt: now() });
    };
    child.on("error", (e) => finish({ status: "error", exitCode: null, signal: null, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? `Command not found: ${o.argv[0]}` : e.message }));
    child.on("close", (code, sig) =>
      finish({
        status: cancelled ? "cancelled" : timedOut ? "timed_out" : code === 0 ? "passed" : "failed",
        exitCode: code,
        signal: sig,
        error: null,
      }),
    );
  });
}
