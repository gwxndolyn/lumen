// Beta reports on the tester's side: drafts that survive a restart, a preview that is byte-for-byte
// the file that will be written, and an honest export status. Lumen has no feedback server; a
// report reaches the team only when the user saves the file and sends it themselves (docs/BETA.md
// §11 says where). Nothing here opens a network connection.

import { randomUUID } from "node:crypto";
import type { Store } from "../storage/db";
import { buildReport, describeContents, reportInputSchema, serialize, type BetaReport, type BuildContext, type InteractionMeta, type LogEvent, type ReportInput } from "./report";

export type ReportStatus = "draft" | "exported" | "export_failed";

export interface ReportRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: ReportStatus;
  input: ReportInput;
  exportedAt: number | null;
  /** File name only (no folder): the folder can contain the user's name. */
  exportedName: string | null;
  lastError: string | null;
}

export interface BetaDeps {
  store: Store;
  now?: () => number;
  home: string;
  app: BetaReport["app"];
  /** Content-free metadata for an answer, or null if it no longer exists. */
  interaction: (messageId: string) => InteractionMeta | null;
  /** The answer's question and text, for the excerpt the user may choose to include and edit. */
  excerptSource: (messageId: string) => { question: string; answer: string } | null;
  diagnostics: (windowHours: number) => { summary: unknown; log: LogEvent[]; logTruncated: boolean };
  usage: () => unknown;
  /** Drafts and export records older than this are deleted (0 = keep). */
  retentionDays: () => number;
  onExported?: (r: BetaReport) => void;
}

/** Diagnostics cover this many hours of operational log, never more. */
export const DIAGNOSTICS_WINDOW_HOURS = 24;
const MAX_DRAFTS = 50;

export class BetaService {
  private readonly now: () => number;
  /** The last preview per report, so export writes exactly the bytes the user looked at. */
  private previewed = new Map<string, { input: string; report: BetaReport; text: string }>();
  constructor(private readonly d: BetaDeps) {
    this.now = d.now ?? Date.now;
  }

  list(): ReportRecord[] {
    return this.d.store.listBetaReports().flatMap((r) => {
      const parsed = reportInputSchema.safeParse(r.input);
      // A malformed row (hand-edited database, older build) is skipped, not shown half-read.
      return parsed.success ? [{ ...r, status: r.status as ReportStatus, input: parsed.data }] : [];
    });
  }

  get(id: string): ReportRecord {
    const r = this.list().find((x) => x.id === id);
    if (!r) throw new Error("That report no longer exists.");
    return r;
  }

  /** Create or update a draft. Validation errors are returned to the form as readable messages. */
  saveDraft(id: string | null, input: unknown): ReportRecord {
    const parsed = reportInputSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid report.");
    const existing = id ? this.d.store.getBetaReport(id) : null;
    if (id && !existing) throw new Error("That report no longer exists.");
    if (!existing && this.d.store.listBetaReports(MAX_DRAFTS + 1).filter((r) => r.status !== "exported").length >= MAX_DRAFTS)
      throw new Error(`You have ${MAX_DRAFTS} unfinished reports. Export or discard some first.`);
    const t = this.now();
    const rec = {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
      // Editing an exported report makes it a draft again: the saved file no longer matches it.
      status: "draft" as ReportStatus,
      input: parsed.data,
      exportedAt: existing?.exportedAt ?? null,
      exportedName: existing?.exportedName ?? null,
      lastError: null,
    };
    this.d.store.saveBetaReport(rec);
    return rec;
  }

  discard(id: string) {
    this.previewed.delete(id);
    if (!this.d.store.deleteBetaReport(id)) throw new Error("That report no longer exists.");
  }

  /** The original excerpt for an answer, offered to the user to edit; null if the answer is gone. */
  excerptFor(messageId: string) {
    return this.d.excerptSource(messageId);
  }

  private context(rec: ReportRecord): BuildContext {
    const mid = rec.input.messageId;
    return {
      id: rec.id,
      now: new Date(this.now()),
      home: this.d.home,
      app: this.d.app,
      interaction: mid ? this.d.interaction(mid) : null,
      diagnostics: () => ({ windowHours: DIAGNOSTICS_WINDOW_HOURS, ...this.d.diagnostics(DIAGNOSTICS_WINDOW_HOURS) }),
      usage: () => this.d.usage(),
      originalExcerpt: mid ? this.d.excerptSource(mid) : null,
    };
  }

  /** Exactly what export would write, plus a plain-language summary of it. */
  preview(id: string): { report: BetaReport; text: string; bytes: number; contents: ReturnType<typeof describeContents>; warnings: string[] } {
    const rec = this.get(id);
    const report = buildReport(rec.input, this.context(rec));
    const text = serialize(report);
    this.previewed.set(id, { input: JSON.stringify(rec.input), report, text });
    const warnings: string[] = [];
    if (rec.input.messageId && !report.interaction) warnings.push("The answer this report referred to was deleted, so it is no longer linked.");
    if (rec.input.include.excerpt && report.attachments.excerpt && !report.attachments.excerpt.editedByUser)
      warnings.push("The excerpt is the original question and answer. Remove anything you don't want to share before exporting.");
    if (report.attachments.diagnostics?.logTruncated) warnings.push("Older log events were left out to keep the file small.");
    return { report, text, bytes: Buffer.byteLength(text), contents: describeContents(report), warnings };
  }

  /**
   * Write the previewed report with `write` (the caller picked the path). Refuses if there is no
   * preview or the report changed since, so the file is always exactly what the user reviewed.
   * The status reflects what actually happened: a failed write is recorded and can be retried;
   * nothing claims the report was sent anywhere.
   */
  export(id: string, fileName: string, write: (text: string) => void): ReportRecord {
    const rec = this.get(id);
    const shown = this.previewed.get(id);
    if (!shown || shown.input !== JSON.stringify(rec.input)) throw new Error("Preview the report before saving it (it changed since the last preview).");
    const report = shown.report;
    try {
      write(shown.text);
    } catch (err) {
      const msg = (err as Error)?.message ?? "Unknown error";
      this.d.store.saveBetaReport({ ...rec, updatedAt: this.now(), status: "export_failed", lastError: msg.slice(0, 300) });
      throw new Error(`The report was not saved: ${msg}`, { cause: err });
    }
    const done = { ...rec, updatedAt: this.now(), status: "exported" as ReportStatus, exportedAt: this.now(), exportedName: fileName.split(/[\\/]/).pop()!.slice(0, 200), lastError: null };
    this.d.store.saveBetaReport(done);
    this.d.onExported?.(report);
    this.previewed.delete(id);
    return done;
  }

  sweep(): number {
    const days = this.d.retentionDays();
    return days > 0 ? this.d.store.pruneBetaReports(this.now() - days * 86_400_000) : 0;
  }
}

/**
 * Parse the operational log (JSON lines) into a bounded, time-windowed list of events. Only the
 * level, the message name and a short set of known-safe fields are kept; free-form fields that
 * could carry anything (stack traces, arbitrary error text) are reduced to their first line and
 * scrubbed later by buildReport.
 */
export function recentLogEvents(logText: string, sinceMs: number, max = 300): { events: LogEvent[]; truncated: boolean } {
  const SAFE = new Set([
    "channel",
    "code",
    "error",
    "status",
    "kind",
    "plan",
    "from",
    "to",
    "window",
    "reason",
    "event",
    "added",
    "imported",
    "failed",
    "skipped",
    "version",
    "schema",
    "purged",
    "message",
  ]);
  const events: LogEvent[] = [];
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = typeof o.t === "string" ? o.t : "";
    const at = Date.parse(t);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const detail = Object.entries(o)
      .filter(([k]) => SAFE.has(k))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`.split("\n")[0]!.slice(0, 120))
      .join(" ");
    events.push({ t, level: String(o.level ?? "info").slice(0, 10), msg: String(o.msg ?? "").slice(0, 120), detail: detail || null });
  }
  const truncated = events.length > max;
  return { events: truncated ? events.slice(-max) : events, truncated };
}
