// Evaluation history: one JSON file per run in its own folder, written atomically. Kept apart from
// the user's database because runs hold only synthetic benchmark data and their own outputs.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fsutil";
import { scrub } from "../supportBundle";
import { EVAL_SCHEMA_VERSION, type EvalRun, type RunListItem } from "./types";

const MAX_RUNS = 200;
const ID = /^[0-9a-f-]{36}$/;

export class EvalStore {
  constructor(
    readonly dir: string,
    private readonly home = "",
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(id: string) {
    if (!ID.test(id)) throw new Error("Invalid run id.");
    return path.join(this.dir, `${id}.json`);
  }

  private get metaFile() {
    return path.join(this.dir, "meta.json");
  }

  private meta(): { baselineId: string | null } {
    try {
      const m = JSON.parse(fs.readFileSync(this.metaFile, "utf8")) as { baselineId?: unknown };
      return { baselineId: typeof m.baselineId === "string" && ID.test(m.baselineId) ? m.baselineId : null };
    } catch {
      return { baselineId: null };
    }
  }

  save(run: EvalRun) {
    writeFileAtomic(this.file(run.id), scrub(JSON.stringify(run), this.home));
    this.prune();
  }

  get(id: string): EvalRun | null {
    const file = this.file(id); // throws on a malformed id, outside the not-found handling below
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as EvalRun;
      if (run.schemaVersion !== EVAL_SCHEMA_VERSION) return null;
      // A run that was still "running" when the app stopped never finished.
      if (run.status === "running") return { ...run, status: "partial", stopReason: run.stopReason ?? "Interrupted: Lumen closed before the run finished." };
      return run;
    } catch {
      return null;
    }
  }

  list(): RunListItem[] {
    const baselineId = this.meta().baselineId;
    const out: RunListItem[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^([0-9a-f-]{36})\.json$/.exec(f);
      if (!m) continue;
      const r = this.get(m[1]!);
      if (!r) continue;
      out.push({
        id: r.id,
        createdAt: r.createdAt,
        status: r.status,
        mode: r.config.mode,
        model: r.config.model,
        label: r.config.label ?? (r.experiment ? `${r.experiment.name} · ${r.experiment.variant}` : undefined),
        benchmarkVersion: r.benchmarkVersion,
        counts: r.summary.counts,
        isBaseline: r.id === baselineId,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  delete(id: string) {
    fs.rmSync(this.file(id), { force: true });
    if (this.meta().baselineId === id) this.setBaseline(null);
  }

  baselineId(): string | null {
    const id = this.meta().baselineId;
    return id && fs.existsSync(this.file(id)) ? id : null;
  }

  setBaseline(id: string | null) {
    if (id) {
      const run = this.get(id);
      if (!run) throw new Error("That run no longer exists.");
      if (run.status !== "complete") throw new Error("Only a complete run can be the baseline. Partial or cancelled runs would hide cases.");
    }
    writeFileAtomic(this.metaFile, JSON.stringify({ baselineId: id }));
  }

  clear() {
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith(".json")) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  /** Keep the newest runs (and the baseline) so history cannot grow without bound. */
  private prune() {
    const runs = this.list();
    if (runs.length <= MAX_RUNS) return;
    for (const r of runs.slice(MAX_RUNS)) if (!r.isBaseline) fs.rmSync(this.file(r.id), { force: true });
  }
}
