// Beta report: the one file format that carries a tester's feedback from their computer to the
// Lumen team. The desktop app builds it (after the user previews it); the reviewer tool
// (scripts/triage.mjs) validates it again on import. Both sides use this module, so the limits and
// redaction cannot drift apart.
//
// Data minimisation (tested in src/test/betaProgramme.test.ts):
// - Always included: what the user typed (credential-scrubbed), the category, optional severity /
//   area / steps, coarse app and OS versions. Nothing that identifies the person or the machine
//   (no hostname, username, home path, IP, hardware serials, install id).
// - Only when the user ticks the box and sees it in the preview: a diagnostics summary (counts,
//   statuses, error codes, timings, recent operational log events), a usage summary (aggregate
//   counters), and an excerpt of one question/answer the user can edit before export.
// - Never: API keys, screenshots, audio, transcripts, documents, notes, conversation history.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactCredentials, redactHome } from "../credentials";
import { redact as redactSensitive } from "../context/sensitivity";

export const REPORT_KIND = "lumen-beta-report";
export const REPORT_SCHEMA_VERSION = 1;
/** Hard cap on the exported file. The importer enforces it again before parsing. */
export const MAX_REPORT_BYTES = 256 * 1024;
export const LIMITS = { description: 4000, steps: 2000, excerpt: 2000, title: 120 } as const;

export const REPORT_CATEGORIES = ["privacy", "crash", "broken", "answer_quality", "capture", "performance", "confusing", "missing_feature", "feature_request", "usefulness", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  privacy: "Privacy or security concern",
  crash: "Crash or unexpected error",
  broken: "Something doesn't work",
  answer_quality: "Incorrect or low-quality answer",
  capture: "Screen, transcription or context problem",
  performance: "Slow or unresponsive",
  confusing: "Confusing workflow",
  missing_feature: "Missing functionality",
  feature_request: "Feature request",
  usefulness: "Overall usefulness",
  other: "Other",
};

export const AREAS = ["assistant", "screen_capture", "transcription", "knowledge", "memory", "sessions", "provider_setup", "local_model", "onboarding", "settings", "updates", "other"] as const;
export const SEVERITIES = ["blocker", "major", "minor"] as const;

/** What the user filled in. Stored as a draft; the report is built from it at preview/export. */
export const reportInputSchema = z.object({
  category: z.enum(REPORT_CATEGORIES),
  description: z.string().trim().min(1, "Describe what happened.").max(LIMITS.description),
  severity: z.enum(SEVERITIES).nullable().default(null),
  area: z.enum(AREAS).nullable().default(null),
  steps: z.string().max(LIMITS.steps).nullable().default(null),
  /** 1 (not useful) … 5 (very useful); only meaningful for the usefulness category. */
  usefulness: z.number().int().min(1).max(5).nullable().default(null),
  /** The answer this report is about (local id; lets the reporter's own install find it again). */
  messageId: z.string().min(1).max(100).nullable().default(null),
  include: z
    .object({
      diagnostics: z.boolean().default(false),
      usage: z.boolean().default(false),
      excerpt: z.boolean().default(false),
    })
    .default({ diagnostics: false, usage: false, excerpt: false }),
  /** User-edited question/answer excerpt. Only used when include.excerpt is true. */
  excerpt: z
    .object({ question: z.string().max(LIMITS.excerpt), answer: z.string().max(LIMITS.excerpt) })
    .nullable()
    .default(null),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

/** Content-free description of one answer (copied from its metadata, never its text). */
const interactionSchema = z.object({
  messageId: z.string().max(100),
  category: z.string().max(40).nullable(),
  provider: z.string().max(40).nullable(),
  model: z.string().max(120).nullable(),
  route: z.string().max(40).nullable(),
  contextSources: z.array(z.string().max(40)).max(20),
  ttftMs: z.number().nullable(),
  totalMs: z.number().nullable(),
  verificationFlags: z.array(z.string().max(60)).max(20),
  stopReason: z.string().max(40).nullable(),
  promptHash: z.string().max(40).nullable(),
});
export type InteractionMeta = z.infer<typeof interactionSchema>;

const scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
/** Diagnostics are a bounded tree of scalars; anything deeper or bigger is rejected. */
const tree: z.ZodType<unknown> = z.lazy(() => z.union([scalar, z.array(tree).max(400), z.record(z.string().max(80), tree)]));

const logEventSchema = z.object({ t: z.string().max(40), level: z.string().max(10), msg: z.string().max(120), detail: z.string().max(300).nullable() });
export type LogEvent = z.infer<typeof logEventSchema>;

export const reportSchema = z.object({
  kind: z.literal(REPORT_KIND),
  schemaVersion: z.number().int(),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  category: z.enum(REPORT_CATEGORIES),
  description: z.string().min(1).max(LIMITS.description),
  severity: z.enum(SEVERITIES).nullable(),
  area: z.enum(AREAS).nullable(),
  steps: z.string().max(LIMITS.steps).nullable(),
  usefulness: z.number().int().min(1).max(5).nullable(),
  app: z.object({
    version: z.string().max(40),
    platform: z.string().max(20),
    arch: z.string().max(20),
    osRelease: z.string().max(60),
    electron: z.string().max(40).nullable(),
    packaged: z.boolean(),
  }),
  /** Correlation id of the answer, when the user picked one (random id, meaningless outside their install). */
  interaction: interactionSchema.nullable(),
  attachments: z.object({
    diagnostics: z.object({ windowHours: z.number(), summary: tree, log: z.array(logEventSchema).max(300), logTruncated: z.boolean() }).nullable(),
    usage: tree.nullable(),
    excerpt: z.object({ question: z.string().max(LIMITS.excerpt), answer: z.string().max(LIMITS.excerpt), editedByUser: z.boolean() }).nullable(),
  }),
});
export type BetaReport = z.infer<typeof reportSchema>;

/** Scrub free text: credentials, other secrets (cards, passwords), the home directory, control characters. */
export function scrubText(s: string, home: string, max: number): string {
  // Control and bidi-override characters: they can hide or reorder text in a reviewer's terminal.
  // oxlint-disable-next-line no-control-regex
  const noControl = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
  return redactHome(redactSensitive(redactCredentials(noControl)), home)
    .slice(0, max)
    .trim();
}

export interface BuildContext {
  id?: string;
  now: Date;
  home: string;
  app: BetaReport["app"];
  interaction: InteractionMeta | null;
  diagnostics: (() => { windowHours: number; summary: unknown; log: LogEvent[]; logTruncated: boolean }) | null;
  usage: (() => unknown) | null;
  /** Original question/answer text, used only to tell whether the user edited the excerpt. */
  originalExcerpt: { question: string; answer: string } | null;
}

/**
 * Build the exact report that the preview shows and the export writes. Throws if the result would
 * exceed MAX_REPORT_BYTES even after dropping the oldest log events.
 */
export function buildReport(input: ReportInput, ctx: BuildContext): BetaReport {
  const i = reportInputSchema.parse(input);
  const t = (s: string | null, max: number) => (s && s.trim() ? scrubText(s, ctx.home, max) : null);
  const ex = i.include.excerpt && i.excerpt ? { question: scrubText(i.excerpt.question, ctx.home, LIMITS.excerpt), answer: scrubText(i.excerpt.answer, ctx.home, LIMITS.excerpt) } : null;
  const diag = i.include.diagnostics && ctx.diagnostics ? ctx.diagnostics() : null;
  const report: BetaReport = {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: ctx.id ?? randomUUID(),
    createdAt: ctx.now.toISOString(),
    category: i.category,
    description: scrubText(i.description, ctx.home, LIMITS.description) || "(empty after removing sensitive values)",
    severity: i.severity,
    area: i.area,
    steps: t(i.steps, LIMITS.steps),
    usefulness: i.category === "usefulness" ? i.usefulness : null,
    app: ctx.app,
    interaction: i.messageId && ctx.interaction?.messageId === i.messageId ? ctx.interaction : null,
    attachments: {
      diagnostics: diag
        ? {
            windowHours: diag.windowHours,
            summary: JSON.parse(scrubText(JSON.stringify(diag.summary ?? {}), ctx.home, 200_000) || "{}"),
            log: diag.log.map((l) => ({ ...l, msg: scrubText(l.msg, ctx.home, 120), detail: l.detail == null ? null : scrubText(l.detail, ctx.home, 300) })),
            logTruncated: diag.logTruncated,
          }
        : null,
      usage: i.include.usage && ctx.usage ? (ctx.usage() ?? null) : null,
      excerpt: ex && (ex.question || ex.answer) ? { ...ex, editedByUser: !ctx.originalExcerpt || ex.question !== ctx.originalExcerpt.question || ex.answer !== ctx.originalExcerpt.answer } : null,
    },
  };
  // Keep the newest log events if the file would be too large.
  const d = report.attachments.diagnostics;
  if (d)
    while (d.log.length && Buffer.byteLength(serialize(report)) > MAX_REPORT_BYTES) {
      d.log.splice(0, Math.max(1, Math.ceil(d.log.length / 4)));
      d.logTruncated = true;
    }
  if (Buffer.byteLength(serialize(report)) > MAX_REPORT_BYTES) throw new Error("The report is too large to export. Shorten the excerpt or leave out diagnostics.");
  return reportSchema.parse(report);
}

export function serialize(r: BetaReport): string {
  return JSON.stringify(r, null, 2);
}

export type ParseResult = { ok: true; report: BetaReport; upgradedFrom: number | null } | { ok: false; error: string };

/**
 * Validate a report file from an untrusted source (the reviewer side). Size is checked before
 * parsing; unknown future versions are rejected rather than half-read; every text field is
 * scrubbed again in case the file was produced or edited outside Lumen.
 */
export function parseReport(raw: string | Buffer, home = ""): ParseResult {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (bytes > MAX_REPORT_BYTES) return { ok: false, error: `File is ${bytes} bytes; the limit is ${MAX_REPORT_BYTES}.` };
  let data: unknown;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  if (!data || typeof data !== "object" || (data as { kind?: unknown }).kind !== REPORT_KIND) return { ok: false, error: "Not a Lumen beta report." };
  const v = (data as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, error: "Missing schema version." };
  if (v > REPORT_SCHEMA_VERSION) return { ok: false, error: `Report schema ${v} is newer than this tool (${REPORT_SCHEMA_VERSION}); update the reviewer tool.` };
  const { data: upgraded, from } = upgrade(data as Record<string, unknown>, v);
  const parsed = reportSchema.safeParse(upgraded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid report: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim() };
  }
  const r = parsed.data;
  const s = (x: string, max: number) => scrubText(x, home, max);
  const ex = r.attachments.excerpt;
  return {
    ok: true,
    upgradedFrom: from,
    report: {
      ...r,
      description: s(r.description, LIMITS.description),
      steps: r.steps == null ? null : s(r.steps, LIMITS.steps),
      attachments: { ...r.attachments, excerpt: ex ? { ...ex, question: s(ex.question, LIMITS.excerpt), answer: s(ex.answer, LIMITS.excerpt) } : null },
    },
  };
}

/** Schema migrations for older report files. Version 1 is the first; add steps here, never edit old ones. */
function upgrade(data: Record<string, unknown>, version: number): { data: Record<string, unknown>; from: number | null } {
  const out = data;
  const from = version < REPORT_SCHEMA_VERSION ? version : null;
  // (no older versions yet)
  return { data: { ...out, schemaVersion: REPORT_SCHEMA_VERSION }, from };
}

/** Human-readable list of what a report contains, for the preview. */
export function describeContents(r: BetaReport): { included: string[]; excluded: string[] } {
  const included = [
    "Category, your description" + (r.steps ? ", steps" : "") + (r.severity ? ", severity" : "") + (r.area ? ", area" : ""),
    `Lumen ${r.app.version} on ${r.app.platform} ${r.app.osRelease} (${r.app.arch})`,
  ];
  if (r.interaction) included.push(`Which answer this is about: task type, model, timings and answer-check results (no text)`);
  if (r.attachments.diagnostics) included.push(`Diagnostics summary and ${r.attachments.diagnostics.log.length} operational log events from the last ${r.attachments.diagnostics.windowHours} h`);
  if (r.attachments.usage) included.push("Usage summary (counts only)");
  if (r.attachments.excerpt) included.push("The question and answer excerpt shown below" + (r.attachments.excerpt.editedByUser ? " (as you edited it)" : ""));
  const excluded = ["API keys and tokens", "Screenshots, audio and transcripts", "Documents, notes and project memory", "Other conversations", "Your name, computer name and home folder"];
  if (!r.attachments.excerpt) excluded.unshift("The question and answer text");
  if (!r.attachments.diagnostics) excluded.push("Diagnostics and log events");
  return { included, excluded };
}
