import { ProviderError } from "./providers/types";

/**
 * Turn storage / OS errors into actionable, non-sensitive user messages. Never includes paths,
 * SQL, prompt content or stack traces.
 */
export function toUserError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  const errcode = Number(e?.errcode ?? NaN);
  const msg = String(e?.message ?? "");
  if (code === "ENOSPC" || errcode === 13 || /SQLITE_FULL|database or disk is full/i.test(msg)) {
    return new ProviderError("Your disk is full, so Lumen couldn't save. Free up some space and try again — your question was not lost.", "storage", false);
  }
  if (errcode === 11 || errcode === 26 || /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg)) {
    return new ProviderError("Lumen's local database appears to be damaged. Restart Lumen to repair it; a backup is kept automatically.", "storage", false);
  }
  if (code === "EACCES" || code === "EPERM" || errcode === 8 || /readonly|permission denied/i.test(msg)) {
    return new ProviderError("Lumen doesn't have permission to write its data folder. Check the folder's permissions in Diagnostics.", "storage", false);
  }
  if (errcode === 5 || errcode === 6 || /SQLITE_BUSY|database is locked/i.test(msg)) {
    return new ProviderError("Lumen's database is busy. Try again in a moment.", "storage", true);
  }
  return new ProviderError("Something went wrong generating the answer.", "unknown", false);
}
