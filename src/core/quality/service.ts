// Local quality loop: response feedback, content-free quality events, metrics derived from them,
// and turning a user-approved failure into a reusable evaluation case.
//
// Privacy rules (tested):
// - Events never contain prompts, answers, context, transcripts or screen text — only types,
//   provider/model ids, task category, error codes, latencies and route.
// - Feedback stores its metadata plus only what the user typed (note, expected answer), scrubbed
//   of secrets. The question and answer are read from the conversation only when the user opens
//   "Create test case", shown for review, and saved only on their confirmation.
// - Everything stays in the local database; nothing is sent anywhere.

import { randomUUID } from "node:crypto";
import { redact } from "../context/sensitivity";
import type { ChatEvent, ChatMessage } from "../../shared/types";
import type { Store } from "../storage/db";
import { caseHash } from "../eval/runner";
import type { Check, EvalCase, EvalCategory } from "../eval/types";

export const FEEDBACK_KINDS = ["helpful", "incorrect", "incomplete", "irrelevant_context", "too_slow", "too_verbose", "bad_formatting", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_LABELS: Record<FeedbackKind, string> = {
  helpful: "Helpful",
  incorrect: "Incorrect",
  incomplete: "Incomplete",
  irrelevant_context: "Irrelevant context",
  too_slow: "Too slow",
  too_verbose: "Too verbose",
  bad_formatting: "Incorrect formatting",
  other: "Other",
};

/** Feedback metadata copied from the message. No content fields. */
export interface FeedbackMeta {
  category: string | null;
  relation: string | null;
  provider: string | null;
  model: string | null;
  route: string | null;
  promptHash: string | null;
  appVersion: string;
  contextSources: string[];
  ttftMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  verificationFlags: string[];
  stopReason: string | null;
}

export interface FeedbackRecord {
  id: string;
  messageId: string | null;
  createdAt: number;
  kind: FeedbackKind;
  note: string | null;
  expected: string | null;
  meta: FeedbackMeta;
}

export type QualityEventType =
  | "request_completed"
  | "request_failed"
  | "request_cancelled"
  | "retry"
  | "verification_flagged"
  | "feedback"
  | "context_selected"
  // Setup and lifecycle milestones (content-free; `code` holds a short outcome or kind).
  | "app_started"
  | "onboarding_completed"
  | "provider_test"
  | "context_activated"
  | "session_restored"
  | "report_exported"
  | "diagnostics_exported"
  | "update_check";

/** Milestones recordable through `record()`. Request events come only from observe(). */
export const MILESTONES = ["app_started", "onboarding_completed", "provider_test", "context_activated", "session_restored", "report_exported", "diagnostics_exported", "update_check"] as const;
export type Milestone = (typeof MILESTONES)[number];

const MAX_NOTE = 2000;
const clean = (s: string | null | undefined, max = MAX_NOTE) => {
  const t = (s ?? "").trim();
  return t ? redact(t).slice(0, max) : null;
};

export interface QualityDeps {
  store: Store;
  appVersion: string;
  promptHash: string;
  now?: () => number;
  retentionDays?: () => number;
  /** Settings → Privacy → "Record usage events". When false nothing new is recorded. */
  enabled?: () => boolean;
}

export class QualityService {
  private readonly now: () => number;
  /** Per-request facts gathered from the chat stream (dropped when the request ends). */
  private pending = new Map<string, { provider: string; model: string; category: string; route: string | null; sources: string[] }>();

  constructor(private readonly d: QualityDeps) {
    this.now = d.now ?? Date.now;
  }

  private get on() {
    return this.d.enabled?.() ?? true;
  }

  /**
   * Record a setup or lifecycle milestone. `code` is a short machine value (an outcome, a source
   * kind, an error code) — never user content; it is truncated and restricted to a safe alphabet.
   */
  record(type: Milestone, code: string | null = null, extra: { provider?: string | null; latencyMs?: number | null } = {}) {
    if (!this.on || !MILESTONES.includes(type)) return;
    const c = code == null ? null : code.replace(/[^a-z0-9_.:-]/gi, "").slice(0, 40) || null;
    this.d.store.addQualityEvent({ at: this.now(), type, code: c, provider: extra.provider ?? null, latencyMs: extra.latencyMs ?? null });
  }

  /** Observe chat events. Records content-free facts only. */
  observe(e: ChatEvent) {
    if (!this.on) {
      this.pending.clear();
      return;
    }
    const s = this.d.store;
    switch (e.type) {
      case "start":
        this.pending.set(e.requestId, {
          provider: e.provider.kind,
          model: e.provider.model,
          category: e.intent.category,
          route: e.routing?.route ?? null,
          sources: [...new Set(e.references.map((r) => r.kind))],
        });
        s.addQualityEvent({
          at: this.now(),
          type: "context_selected",
          provider: e.provider.kind,
          model: e.provider.model,
          category: e.intent.category,
          route: e.routing?.route ?? null,
          detail: JSON.stringify({ included: e.selection.included, dropped: e.selection.droppedForBudget, chars: e.selection.contextChars }),
        });
        break;
      case "retrying": {
        const p = this.pending.get(e.requestId);
        s.addQualityEvent({ at: this.now(), type: "retry", provider: p?.provider, model: p?.model, category: p?.category });
        break;
      }
      case "done": {
        const p = this.pending.get(e.requestId);
        s.addQualityEvent({
          at: this.now(),
          type: "request_completed",
          provider: p?.provider,
          model: p?.model,
          category: p?.category,
          latencyMs: e.totalMs,
          ttftMs: e.ttftMs,
          route: p?.route,
          detail: e.cached ? "cached" : null,
        });
        for (const f of e.verification.findings) s.addQualityEvent({ at: this.now(), type: "verification_flagged", provider: p?.provider, model: p?.model, category: p?.category, code: f.check });
        this.pending.delete(e.requestId);
        break;
      }
      case "error": {
        const p = this.pending.get(e.requestId);
        s.addQualityEvent({ at: this.now(), type: "request_failed", provider: p?.provider, model: p?.model, category: p?.category, code: e.code, route: p?.route });
        this.pending.delete(e.requestId);
        break;
      }
      case "cancelled": {
        const p = this.pending.get(e.requestId);
        s.addQualityEvent({ at: this.now(), type: "request_cancelled", provider: p?.provider, model: p?.model, category: p?.category });
        this.pending.delete(e.requestId);
        break;
      }
    }
  }

  metaFor(m: ChatMessage | null): FeedbackMeta {
    const meta = m?.meta ?? {};
    return {
      category: meta.intent?.category ?? null,
      relation: meta.intent?.relation ?? null,
      provider: meta.provider ?? (meta.isMock ? "mock" : null),
      model: meta.model ?? null,
      route: meta.route ?? null,
      promptHash: this.d.promptHash,
      appVersion: this.d.appVersion,
      contextSources: [...new Set((m?.references ?? []).map((r) => r.kind))],
      ttftMs: meta.ttftMs ?? null,
      totalMs: meta.totalMs ?? null,
      inputTokens: null,
      outputTokens: null,
      verificationFlags: meta.verification?.findings.map((f) => f.check) ?? [],
      stopReason: meta.stopReason ?? null,
    };
  }

  addFeedback(input: { messageId: string | null; kind: FeedbackKind; note?: string | null; expected?: string | null }): FeedbackRecord {
    if (!FEEDBACK_KINDS.includes(input.kind)) throw new Error("Unknown feedback type.");
    const msg = input.messageId ? this.d.store.getMessage(input.messageId) : null;
    if (input.messageId && (!msg || msg.role !== "assistant")) throw new Error("That answer no longer exists.");
    const rec: FeedbackRecord = {
      id: randomUUID(),
      messageId: input.messageId,
      createdAt: this.now(),
      kind: input.kind,
      note: clean(input.note),
      expected: clean(input.expected, 4000),
      meta: this.metaFor(msg),
    };
    this.d.store.addFeedback(rec);
    if (this.on) this.d.store.addQualityEvent({ at: rec.createdAt, type: "feedback", model: rec.meta.model, category: rec.meta.category, code: rec.kind, route: rec.meta.route });
    return rec;
  }

  listFeedback(): FeedbackRecord[] {
    return this.d.store.listFeedback() as unknown as FeedbackRecord[];
  }

  deleteFeedback(id: string) {
    if (!this.d.store.deleteFeedback(id)) throw new Error("That feedback no longer exists.");
  }

  /** Apply retention to events and feedback. */
  sweep() {
    const days = this.d.retentionDays?.() ?? 90;
    return days > 0 ? this.d.store.pruneQuality(this.now() - days * 86_400_000) : 0;
  }

  // ---------- metrics from recorded events (observed, not estimated) ----------
  metrics(days = 30) {
    const ev = this.d.store.qualityEvents(this.now() - days * 86_400_000);
    const count = (t: string) => ev.filter((e) => e.type === t).length;
    const completed = count("request_completed");
    const failed = count("request_failed");
    const cancelled = count("request_cancelled");
    const finished = completed + failed + cancelled;
    const lat = ev
      .filter((e) => e.type === "request_completed" && e.detail !== "cached" && e.latencyMs != null)
      .map((e) => e.latencyMs!)
      .sort((a, b) => a - b);
    const ttft = ev
      .filter((e) => e.type === "request_completed" && e.detail !== "cached" && e.ttftMs != null)
      .map((e) => e.ttftMs!)
      .sort((a, b) => a - b);
    const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]! : null);
    const by = <K extends string>(rows: typeof ev, key: (e: (typeof ev)[number]) => K | null) => {
      const m: Record<string, number> = {};
      for (const e of rows) {
        const k = key(e);
        if (k) m[k] = (m[k] ?? 0) + 1;
      }
      return m;
    };
    const providers = [...new Set(ev.filter((e) => e.type.startsWith("request_")).map((e) => e.provider ?? "unknown"))];
    const byProvider = providers.map((p) => {
      const rs = ev.filter((e) => e.type.startsWith("request_") && (e.provider ?? "unknown") === p);
      const f = rs.filter((e) => e.type === "request_failed").length;
      return { provider: p, requests: rs.length, failed: f, errorRate: rs.length ? f / rs.length : null };
    });
    const days7 = this.now() - 7 * 86_400_000;
    return {
      windowDays: days,
      requests: finished,
      completed,
      failed,
      cancelled,
      successRate: finished ? completed / finished : null,
      cancellationRate: finished ? cancelled / finished : null,
      retries: count("retry"),
      latency: { p50Ms: pct(lat, 50), p95Ms: pct(lat, 95), ttftP50Ms: pct(ttft, 50), n: lat.length },
      failuresByCode: by(
        ev.filter((e) => e.type === "request_failed"),
        (e) => e.code,
      ),
      verificationByCheck: by(
        ev.filter((e) => e.type === "verification_flagged"),
        (e) => e.code,
      ),
      feedbackByKind: by(
        ev.filter((e) => e.type === "feedback"),
        (e) => e.code,
      ),
      byProvider,
      /** Daily latency and success, for trends. */
      daily: dailySeries(ev, this.now(), days),
      last7: { requests: ev.filter((e) => e.at >= days7 && e.type.startsWith("request_")).length },
      preliminary: finished < 30,
    };
  }

  /**
   * Activation facts for this install, from recorded milestones only (definitions in
   * docs/BETA_PROGRAMME.md §5). A value is null when the events it needs were never recorded —
   * e.g. the install predates event recording, or recording is off — never estimated.
   */
  activation() {
    const ev = this.d.store.qualityEvents(0);
    const first = (t: string, pred: (e: (typeof ev)[number]) => boolean = () => true) => ev.find((e) => e.type === t && pred(e))?.at ?? null;
    const started = first("app_started");
    const onboarded = first("onboarding_completed");
    const firstAnswer = first("request_completed", (e) => e.provider !== "mock" && e.detail !== "cached");
    const tests = ev.filter((e) => e.type === "provider_test");
    const testFailed = tests.filter((e) => e.code !== "ok");
    const reqs = ev.filter((e) => e.type === "request_completed" || e.type === "request_failed");
    const days = new Set(ev.filter((e) => e.type === "request_completed").map((e) => new Date(e.at).toDateString()));
    const ratings = this.listFeedback();
    return {
      recordingSince: ev[0]?.at ?? null,
      firstLaunchAt: started,
      onboardingCompletedAt: onboarded,
      firstSuccessfulAnswerAt: firstAnswer,
      /** First recorded launch → first real (non-mock, non-cached) completed answer. */
      timeToFirstAnswerMs: started != null && firstAnswer != null && firstAnswer >= started ? firstAnswer - started : null,
      providerTests: { total: tests.length, failed: testFailed.length, failureCodes: countBy(testFailed.map((e) => e.code ?? "unknown")) },
      requests: { technicalSuccess: reqs.length ? reqs.filter((e) => e.type === "request_completed").length / reqs.length : null, n: reqs.length },
      contextActivated: countBy(ev.filter((e) => e.type === "context_activated").map((e) => e.code ?? "unknown")),
      sessionsRestored: ev.filter((e) => e.type === "session_restored").length,
      launches: ev.filter((e) => e.type === "app_started").length,
      /** Distinct calendar days with at least one completed answer. */
      activeDays: days.size,
      /** User-perceived usefulness: answers rated helpful vs. rated anything else. Separate from technical success. */
      ratedAnswers: { helpful: ratings.filter((f) => f.kind === "helpful").length, notHelpful: ratings.filter((f) => f.kind !== "helpful").length },
      reportsExported: ev.filter((e) => e.type === "report_exported").length,
      updateChecks: countBy(ev.filter((e) => e.type === "update_check").map((e) => e.code ?? "unknown")),
    };
  }

  // ---------- feedback → evaluation case (user-reviewed) ----------

  /**
   * Draft a benchmark case from a flagged answer. Returned for review only; nothing is saved.
   * The question is redacted; the user's own context is NOT copied into fixtures — they must
   * paste the minimal synthetic fixture they're willing to keep.
   */
  draftCase(feedbackId: string): { draft: EvalCase; question: string; answer: string; warnings: string[] } {
    const fb = this.d.store.getFeedback(feedbackId) as unknown as FeedbackRecord | null;
    if (!fb) throw new Error("That feedback no longer exists.");
    const answer = fb.messageId ? this.d.store.getMessage(fb.messageId) : null;
    if (!answer) throw new Error("The answer this feedback refers to was deleted, so there is nothing to turn into a test case.");
    const msgs = this.d.store.listMessages(answer.conversationId);
    const idx = msgs.findIndex((m) => m.id === answer.id);
    const q = msgs.slice(0, idx).findLast((m) => m.role === "user");
    const question = redact(q?.content ?? "");
    const warnings: string[] = [];
    if (question !== (q?.content ?? "")) warnings.push("Sensitive values in the question were masked.");
    if (fb.meta.contextSources.length)
      warnings.push(`The original answer used ${fb.meta.contextSources.join(", ")} context. It is not copied; add a minimal synthetic fixture yourself if the case needs one.`);
    warnings.push("One person's feedback is not proof the model is wrong. Write criteria that check something objective.");
    const category = FEEDBACK_TO_CATEGORY[fb.meta.category ?? ""] ?? "research_factual";
    const answerChecks: Check[] = [];
    if (fb.expected)
      answerChecks.push({
        assertion: { type: "answer_matches", pattern: escapeRe(fb.expected.split(/\s+/).slice(0, 6).join(" ")) },
        metric: "correctness",
        describe: "Contains the expected answer (edit this pattern)",
      });
    if (fb.kind === "too_verbose") answerChecks.push({ assertion: { type: "answer_max_words", max: 150 }, metric: "instruction_compliance", describe: "Stays short" });
    if (fb.kind === "bad_formatting")
      answerChecks.push({ assertion: { type: "answer_not_matches", pattern: "^```[a-z]*\\n(?![\\s\\S]*```)", flags: "m" }, metric: "instruction_compliance", describe: "No unclosed code block" });
    answerChecks.push({ assertion: { type: "answer_no_unknown_citations" }, metric: "groundedness", describe: "Cites only sources that were sent" });
    const draft: EvalCase = {
      id: `user-${fb.id.slice(0, 8)}`,
      category,
      difficulty: "medium",
      title: `From feedback: ${FEEDBACK_LABELS[fb.kind]}${fb.note ? ` — ${fb.note.slice(0, 60)}` : ""}`,
      request: { question: question.slice(0, 4000) },
      fixtures: [],
      pipeline: [
        { assertion: { type: "outcome", expect: "done" }, metric: "reliability", describe: "The request completes" },
        ...(fb.meta.category
          ? [{ assertion: { type: "category" as const, expect: fb.meta.category }, metric: "task_completion" as const, describe: `Classified as ${fb.meta.category} (as when reported)` }]
          : []),
      ],
      answer: answerChecks,
      failureConditions: [fb.note ?? `Reported as ${FEEDBACK_LABELS[fb.kind].toLowerCase()}`],
      method: "User-reported failure, reviewed before saving",
    };
    return { draft, question, answer: answer.content, warnings };
  }

  /** Save a reviewed case. The user's edited version is validated, never trusted blindly. */
  saveCase(def: EvalCase, feedbackId: string | null): EvalCase {
    const c = validateUserCase(def);
    this.d.store.saveUserCase(c.id, c, feedbackId, this.now());
    return c;
  }

  userCases(): { case: EvalCase; createdAt: number; feedbackId: string | null; lastRun: unknown; hash: string }[] {
    return this.d.store.listUserCases().flatMap((r) => {
      try {
        const c = validateUserCase(r.definition as EvalCase);
        return [{ case: c, createdAt: r.createdAt, feedbackId: r.feedbackId, lastRun: r.lastRun, hash: caseHash(c) }];
      } catch {
        return [];
      }
    });
  }
}

const FEEDBACK_TO_CATEGORY: Record<string, EvalCategory> = {
  algorithm: "algorithms",
  debugging: "coding_debugging",
  code_explanation: "code_review",
  meeting_summary: "meeting_notes",
  general: "research_factual",
  language_framework: "research_factual",
  database_sql: "coding_debugging",
  api_backend: "research_factual",
  frontend: "coding_debugging",
  testing: "coding_debugging",
  system_design: "research_factual",
};

function countBy(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ASSERTION_TYPES = new Set([
  "outcome",
  "retries",
  "category",
  "relation",
  "ambiguous",
  "sent_contains",
  "sent_not_contains",
  "system_contains",
  "system_not_contains",
  "sources",
  "warning",
  "no_warning",
  "history_messages",
  "sent_chars",
  "availability_transcript",
  "verify_flags",
  "answer_matches",
  "answer_not_matches",
  "answer_code_lang",
  "answer_has_code",
  "answer_cites",
  "answer_no_unknown_citations",
  "answer_max_words",
  "answer_parses_json",
]);

export function validateUserCase(c: EvalCase): EvalCase {
  if (!c || typeof c !== "object") throw new Error("Invalid case.");
  if (!/^user-[a-z0-9-]{4,40}$/.test(c.id)) throw new Error("User case ids must start with “user-”.");
  if (!c.request?.question?.trim()) throw new Error("The case needs a question.");
  if (c.request.question.length > 4000) throw new Error("The question is too long (max 4,000 characters).");
  const checks = [...(c.pipeline ?? []), ...(c.answer ?? [])];
  if (!checks.length) throw new Error("Add at least one acceptance criterion.");
  for (const ch of checks) {
    if (!ASSERTION_TYPES.has(ch.assertion?.type)) throw new Error(`Unsupported check “${String(ch.assertion?.type)}”.`);
    const a = ch.assertion as { pattern?: string };
    if (a.pattern !== undefined) {
      if (a.pattern.length > 300) throw new Error("A pattern is too long.");
      try {
        RegExp(a.pattern);
      } catch {
        throw new Error(`Invalid pattern: ${a.pattern}`);
      }
    }
  }
  if ((c.fixtures ?? []).length > 10 || JSON.stringify(c.fixtures ?? []).length > 20_000) throw new Error("Fixtures are too large.");
  // Re-redact everything the user may have pasted.
  const scrub = (s: string) => redact(s);
  return {
    ...c,
    title: scrub(String(c.title ?? c.id)).slice(0, 160),
    request: { ...c.request, question: scrub(c.request.question) },
    fixtures: (c.fixtures ?? []).map((f) => scrubDeep(f, scrub)),
    failureConditions: (c.failureConditions ?? []).map((x) => scrub(String(x)).slice(0, 300)),
    method: String(c.method ?? "User case").slice(0, 200),
    deterministicOnly: false,
  };
}

function dailySeries(ev: { at: number; type: string; latencyMs: number | null; detail: string | null }[], now: number, days: number) {
  const out: { day: string; requests: number; failed: number; p50Ms: number | null }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now - i * 86_400_000);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + 86_400_000;
    const rs = ev.filter((e) => e.at >= start.getTime() && e.at < end && e.type.startsWith("request_"));
    if (!rs.length) continue;
    const lat = rs
      .filter((e) => e.type === "request_completed" && e.detail !== "cached" && e.latencyMs != null)
      .map((e) => e.latencyMs!)
      .sort((a, b) => a - b);
    // Local calendar date (toISOString would shift it a day in time zones ahead of UTC).
    const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    out.push({ day, requests: rs.length, failed: rs.filter((e) => e.type === "request_failed").length, p50Ms: lat.length ? lat[Math.floor(lat.length / 2)]! : null });
  }
  return out;
}

/** Redact every string inside a value (redacting serialised JSON could break its quoting). */
function scrubDeep<T>(v: T, scrub: (s: string) => string): T {
  if (typeof v === "string") return scrub(v) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, scrub)])) as T;
  return v;
}
