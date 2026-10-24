import fs from "node:fs";
import path from "node:path";
import { redactCredentials } from "../src/core/credentials";

const MAX_BYTES = 5 * 1024 * 1024;

/** Strip anything that looks like a credential before it reaches disk. */
export function redact(input: string): string {
  return redactCredentials(input);
}

export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level | "off", number> = { debug: 0, info: 1, warn: 2, error: 3, off: 9 };

/**
 * Structured JSON-lines logger. Only operational metadata is logged — never prompts, answers,
 * transcripts, screenshots or document content.
 */
export class Logger {
  readonly file: string;
  /** Minimum level written to disk; "off" disables file logging entirely. */
  level: "off" | "error" | "info" | "debug" = "info";

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "lumen.log");
  }

  log(level: Level, msg: string, data?: Record<string, unknown>) {
    const min = this.level === "error" ? "error" : this.level;
    if (RANK[level] < RANK[min]) return;
    const line = redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...data })) + "\n";
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      /* logging must never crash the app */
    }
    if (level !== "info" || process.env.LUMEN_DEBUG) console[level === "error" ? "error" : "log"](line.trim());
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>) {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>) {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>) {
    this.log("error", msg, data);
  }
}
