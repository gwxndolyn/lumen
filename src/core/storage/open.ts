import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, Store } from "./db";

export type OpenOutcome =
  | { kind: "ok" }
  | { kind: "migrated"; from: number; to: number; backup: string }
  | { kind: "recovered"; reason: string; quarantined: string };

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function moveSidecars(file: string, to: string) {
  for (const x of ["-wal", "-shm"]) if (fs.existsSync(file + x)) fs.renameSync(file + x, to + x);
}

/**
 * Open the user database safely:
 * - back up the file before applying pending migrations (keeps the most recent backup);
 * - if the file is corrupt, or a migration fails, move it (and WAL/SHM) aside to a quarantine
 *   file and start a fresh database, reporting what happened so the UI can tell the user.
 * User data is never silently deleted — the quarantined copy stays on disk for recovery.
 */
export function openStore(file: string, migrations = MIGRATIONS): { store: Store; outcome: OpenOutcome } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fromVersion = 0;
  let backup: string | null = null;
  try {
    if (fs.existsSync(file)) {
      const probe = new DatabaseSync(file);
      try {
        const check = probe.prepare("PRAGMA quick_check").get() as { quick_check: string };
        if (check.quick_check !== "ok") throw new Error(`integrity check failed: ${check.quick_check}`);
        fromVersion = Number((probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
        if (fromVersion > migrations.length) throw new Error(`database was created by a newer Lumen (schema ${fromVersion})`);
        if (fromVersion < migrations.length) {
          probe.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          backup = `${file}.backup-v${fromVersion}`;
          probe.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        }
      } finally {
        probe.close();
      }
    }
    const store = new Store(file, migrations);
    if (backup) {
      // Keep only the most recent pre-migration backup.
      for (const f of fs.readdirSync(path.dirname(file))) {
        const full = path.join(path.dirname(file), f);
        if (f.startsWith(`${path.basename(file)}.backup-v`) && full !== backup) fs.rmSync(full, { force: true });
      }
      return { store, outcome: { kind: "migrated", from: fromVersion, to: migrations.length, backup } };
    }
    return { store, outcome: { kind: "ok" } };
  } catch (err) {
    const reason = (err as Error).message.replace(/'[^']*'/g, "…");
    if (/newer Lumen/.test(reason)) throw err; // never quarantine data from a newer version — refuse to start instead
    const quarantined = `${file}.corrupt-${stamp()}`;
    if (fs.existsSync(file)) {
      fs.renameSync(file, quarantined);
      moveSidecars(file, quarantined);
    }
    // A failing migration list cannot produce a usable fresh database either; recover onto the
    // shipped schema. If that also fails, the caller shows a fatal startup error.
    const store = new Store(file, migrations === MIGRATIONS ? migrations : MIGRATIONS);
    return { store, outcome: { kind: "recovered", reason, quarantined } };
  }
}
