// Quality loop: feedback, content-free events and metrics, feedback → user test case, proposals,
// and that regressions can't be hidden by editing cases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./harness";
import { buildProposals } from "../core/quality/proposals";
import { validateUserCase } from "../core/quality/service";
import { EvalService } from "../core/eval/service";
import { EvalStore } from "../core/eval/store";
import { compareRuns } from "../core/eval/compare";
import { runEvaluation } from "../core/eval/runner";
import { BENCHMARK } from "../core/eval/benchmark";
import type { EvalCase } from "../core/eval/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";

const SECRET_Q = "My password: hunter2-fake-pass — what is the capital of Australia?";

async function answered(h: ReturnType<typeof harness>, q = "What is the capital of Australia?") {
  const evts = await h.ask(q);
  const done = evts.find((e) => e.type === "done") as { messageId: string };
  return done.messageId;
}

describe("quality events", () => {
  it("record outcome, model, category and timing — never the question, answer or context", async () => {
    const h = harness({ turns: [{ text: ["Canberra is the capital."] }, { status: 401, error: { type: "authentication_error", message: "bad" } }] });
    h.core.addText("note", "Private note", "Project Falcon budget is 4.2M");
    await h.ask("What is the Falcon budget?");
    await h.ask("Second question");
    const ev = h.store.qualityEvents(0);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["context_selected", "request_completed", "request_failed"]));
    expect(ev.find((e) => e.type === "request_failed")).toMatchObject({ code: "auth", provider: "anthropic" });
    expect(ev.find((e) => e.type === "request_completed")!.latencyMs).toBeGreaterThanOrEqual(0);
    const raw = JSON.stringify(ev);
    expect(raw).not.toMatch(/Falcon|4\.2M|Canberra|Second question/);
  });

  it("metrics come from recorded events and say when the sample is small", async () => {
    const h = harness({ turns: [{ text: ["a"] }, { text: ["b"] }, { status: 529, error: { type: "overloaded_error", message: "x" } }] });
    await h.ask("One");
    await h.ask("Two");
    h.core.settings = { ...h.core.settings, limits: { ...h.core.settings.limits, maxAttempts: 1 } };
    await h.ask("Three");
    const m = h.core.quality.metrics(30);
    expect(m).toMatchObject({ requests: 3, completed: 2, failed: 1, preliminary: true });
    expect(m.successRate).toBeCloseTo(2 / 3);
    expect(m.failuresByCode).toEqual({ overloaded: 1 });
    expect(m.byProvider).toEqual([expect.objectContaining({ provider: "anthropic", requests: 3, failed: 1 })]);
  });

  it("daily rows use the local calendar date", async () => {
    const h = harness();
    await h.ask("One");
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(h.core.quality.metrics(7).daily.at(-1)!.day).toBe(today);
  });

  it("an empty database yields no invented numbers", () => {
    const m = harness().core.quality.metrics(30);
    expect(m).toMatchObject({ requests: 0, successRate: null, latency: { p50Ms: null } });
  });

  it("retention prunes old events and feedback; Delete everything removes them", async () => {
    const h = harness({ settings: { privacy: { conversationRetentionDays: 7 } } });
    h.store.addQualityEvent({ at: Date.now() - 30 * 86_400_000, type: "request_completed" });
    await answered(h);
    h.core.quality.sweep();
    expect(h.store.qualityEvents(0).every((e) => e.at > Date.now() - 8 * 86_400_000)).toBe(true);
    h.core.quality.addFeedback({ messageId: null, kind: "other", note: "general" });
    h.core.deleteAll();
    expect(h.store.qualityEvents(0)).toEqual([]);
    expect(h.store.listFeedback()).toEqual([]);
  });
});

describe("feedback", () => {
  it("attaches the answer's metadata, not its content, and masks secrets in notes", async () => {
    const h = harness({ turns: [{ text: ["Canberra."] }] });
    const mid = await answered(h);
    const fb = h.core.quality.addFeedback({ messageId: mid, kind: "incorrect", note: "wrong, my key is sk-ant-api03-abcdefghijklmnopqrstu", expected: "Canberra" });
    expect(fb.meta).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", category: "general" });
    expect(fb.meta.totalMs).toBeGreaterThanOrEqual(0);
    expect(fb.note).not.toContain("abcdefghijklmnop");
    const raw = JSON.stringify(h.store.listFeedback());
    expect(raw).not.toContain("capital of Australia");
    expect(raw).not.toContain("Canberra.");
  });

  it("can be listed and deleted; rejects unknown answers and kinds", async () => {
    const h = harness();
    const mid = await answered(h);
    const fb = h.core.quality.addFeedback({ messageId: mid, kind: "helpful" });
    expect(h.core.quality.listFeedback().map((f) => f.id)).toEqual([fb.id]);
    h.core.quality.deleteFeedback(fb.id);
    expect(h.core.quality.listFeedback()).toEqual([]);
    expect(() => h.core.quality.deleteFeedback(fb.id)).toThrow(/no longer exists/);
    expect(() => h.core.quality.addFeedback({ messageId: "nope", kind: "helpful" })).toThrow(/no longer exists/);
    expect(() => h.core.quality.addFeedback({ messageId: null, kind: "bogus" as never })).toThrow(/Unknown/);
  });
});

describe("feedback → user test case", () => {
  it("drafts for review only, redacts the question, and copies no context", async () => {
    const h = harness({ turns: [{ text: ["Sydney."] }] });
    h.core.addText("note", "Secret plan", "Merger with Acme closes Friday");
    const mid = await answered(h, SECRET_Q);
    const fb = h.core.quality.addFeedback({ messageId: mid, kind: "incorrect", expected: "Canberra" });
    const before = h.store.listUserCases().length;
    const { draft, warnings } = h.core.quality.draftCase(fb.id);
    expect(h.store.listUserCases().length).toBe(before); // nothing saved yet
    expect(draft.request.question).not.toContain("hunter2");
    expect(JSON.stringify(draft)).not.toContain("Acme");
    expect(draft.fixtures).toEqual([]);
    expect(warnings.join(" ")).toMatch(/masked/);
    expect(draft.answer.some((c) => c.assertion.type === "answer_matches")).toBe(true);
  });

  it("saving validates the case; a saved case runs and its result is kept", async () => {
    const h = harness({ turns: [{ text: ["Sydney."] }] });
    const mid = await answered(h);
    const fb = h.core.quality.addFeedback({ messageId: mid, kind: "incorrect", expected: "Canberra" });
    const { draft } = h.core.quality.draftCase(fb.id);
    expect(() => h.core.quality.saveCase({ ...draft, id: "ctx-001" }, fb.id)).toThrow(/user-/);
    expect(() => h.core.quality.saveCase({ ...draft, pipeline: [], answer: [] }, fb.id)).toThrow(/acceptance criterion/);
    expect(() => h.core.quality.saveCase({ ...draft, answer: [{ assertion: { type: "answer_matches", pattern: "(" }, metric: "correctness", describe: "x" }] }, fb.id)).toThrow(/Invalid pattern/);
    expect(() => h.core.quality.saveCase({ ...draft, answer: [{ assertion: { type: "eval_js" } as never, metric: "correctness", describe: "x" }] }, fb.id)).toThrow(/Unsupported/);
    const saved = h.core.quality.saveCase(draft, fb.id);
    expect(h.core.quality.userCases().map((u) => u.case.id)).toEqual([saved.id]);

    const results: { id: string; status: string }[] = [];
    const svc = new EvalService({
      store: new EvalStore(fs.mkdtempSync(path.join(os.tmpdir(), "lumen-q-"))),
      getSettings: () => DEFAULT_SETTINGS,
      getProvider: () => null,
      emit: () => undefined,
      userCases: () => h.core.quality.userCases().map((u) => u.case),
      onUserCaseResult: (id, r) => (results.push({ id, status: r.status }), h.store.setUserCaseRun(id, r)),
    });
    expect(svc.select({ collection: "user" }).map((c) => c.id)).toEqual([saved.id]);
    expect(svc.select({}).some((c) => c.id.startsWith("user-"))).toBe(false); // shipped benchmark stays separate
    svc.start({ mode: "deterministic", collection: "user" });
    await new Promise((r) => setTimeout(r, 300));
    expect(results).toEqual([{ id: saved.id, status: "passed" }]);
    expect(h.core.quality.userCases()[0]!.lastRun).toMatchObject({ status: "passed" });
  });

  it("validateUserCase re-redacts pasted fixtures", () => {
    const c: EvalCase = { ...BENCHMARK[0]!, id: "user-abcd1234", fixtures: [{ kind: "note", title: "n", text: "password: hunter2-fake-pass" }] };
    expect(JSON.stringify(validateUserCase(c).fixtures)).not.toContain("hunter2");
  });
});

describe("regressions cannot be hidden", () => {
  it("editing a case between runs is reported and counted as inconclusive, not passed", async () => {
    const cases = [BENCHMARK.find((c) => c.id === "code-005")!];
    const base = await runEvaluation({ mode: "deterministic", cases, benchmarkVersion: "x", settings: DEFAULT_SETTINGS });
    // A "fix" that weakens the case's own criterion so it passes with verification off.
    const weakened = [{ ...cases[0]!, pipeline: [cases[0]!.pipeline[0]!] }];
    const cand = await runEvaluation({ mode: "deterministic", cases: weakened, benchmarkVersion: "x", settings: DEFAULT_SETTINGS, variant: { name: "off", verification: false } });
    const cmp = compareRuns(base, cand);
    expect(cmp.counts).toMatchObject({ improved: 0, unchanged: 0, inconclusive: 1 });
    expect(cmp.warnings.join(" ")).toMatch(/case definition\(s\) changed/);
  });

  it("dropping cases from the candidate is reported", async () => {
    const base = await runEvaluation({ mode: "deterministic", cases: BENCHMARK.slice(0, 3), benchmarkVersion: "x", settings: DEFAULT_SETTINGS });
    const cand = await runEvaluation({ mode: "deterministic", cases: BENCHMARK.slice(0, 2), benchmarkVersion: "x", settings: DEFAULT_SETTINGS });
    expect(compareRuns(base, cand).warnings.join(" ")).toMatch(/not run in the candidate/);
  });
});

describe("improvement proposals", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, provider: "anthropic", model: "m", category: "general", code: null, latencyMs: 1000, detail: null, ...extra });

  it("raise nothing from too little data", () => {
    expect(buildProposals({ events: [ev("request_failed", { code: "auth" }), ev("request_completed")], feedback: [] })).toEqual([]);
  });

  it("detect a provider error pattern with evidence and sample size", () => {
    const events = [...Array.from({ length: 6 }, () => ev("request_failed", { code: "rate_limited" })), ...Array.from({ length: 6 }, () => ev("request_completed"))];
    const [p] = buildProposals({ events, feedback: [] });
    expect(p).toMatchObject({ id: "provider-errors-anthropic", severity: "high", sampleSize: 12, preliminary: true });
    expect(p!.evidence.join(" ")).toMatch(/6 × rate_limited/);
    expect(p!.suggestion).toMatch(/rate-limited/);
    expect(p!.verification).toBeTruthy();
  });

  it("detect concentrated negative feedback and irrelevant context", () => {
    const fb = (kind: string, src: string[] = ["knowledge"]) => ({ kind, meta: { category: "debugging", model: "m", contextSources: src } });
    const out = buildProposals({ events: [], feedback: [...Array.from({ length: 5 }, () => fb("irrelevant_context")), fb("helpful")] });
    expect(out.map((p) => p.id)).toEqual(expect.arrayContaining(["feedback-debugging", "irrelevant-context"]));
    expect(out.find((p) => p.id === "irrelevant-context")!.evidence.join(" ")).toMatch(/5 × included knowledge/);
  });

  it("always report benchmark regressions against the baseline, ranked first", async () => {
    const cases = BENCHMARK.filter((c) => ["code-005", "fmt-005", "ctx-001"].includes(c.id));
    const base = await runEvaluation({ mode: "deterministic", cases, benchmarkVersion: "x", settings: DEFAULT_SETTINGS });
    const cand = await runEvaluation({ mode: "deterministic", cases, benchmarkVersion: "x", settings: DEFAULT_SETTINGS, variant: { name: "off", verification: false } });
    const out = buildProposals({ events: Array.from({ length: 6 }, () => ev("request_completed")), feedback: [], latestRun: cand, baselineComparison: compareRuns(base, cand) });
    expect(out[0]).toMatchObject({ id: "eval-regression", severity: "high" });
    expect(out[0]!.evidence.join(" ")).toMatch(/code-005/);
  });
});
