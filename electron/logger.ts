import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

/** Strip anything that looks like a credential before it reaches disk. */
export function redact(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(token|apikey|api_key|authorization|x-api-key)(["'\s:=]+)[^\s"',}]{8,}/gi, "$1$2[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{40}\b/g, "[REDACTED]");
}

export type Level = "info" | "warn" | "error";

/**
 * Structured JSON-lines logger. Only operational metadata is logged — never prompts, answers,
 * transcripts, screenshots or document content.
 */
export class Logger {
  readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "lumen.log");
  }

  log(level: Level, msg: string, data?: Record<string, unknown>) {
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
