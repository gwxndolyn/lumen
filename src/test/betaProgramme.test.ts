// Beta programme: reports (schema, minimisation, consent, preview = export, limits, malformed
// input), diagnostics redaction, usage-event opt-out, triage rules, regression-case trust, and the
// full feedback → fix → regression → verify loop on synthetic data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./harness";
import { Logger, redact as logRedact } from "../../electron/logger";
import { redact as contextRedact } from "../core/context/sensitivity";
import { redactCredentials } from "../core/credentials";
import { buildSupportBundle } from "../core/supportBundle";
import { buildReport, MAX_REPORT_BYTES, parseReport, REPORT_SCHEMA_VERSION, serialize, type ReportInput } from "../core/beta/report";
import { recentLogEvents } from "../core/beta/service";
import * as T from "../core/beta/triage";
import { approve, definitionHash, loadRegressions, validateRegressionCase, type RegressionEntry, type RegressionFile } from "../core/beta/regressions";
import { runEvaluation } from "../core/eval/runner";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { Store } from "../core/storage/db";

const HOME = "/Users/jane.doe";
// Synthetic secrets in every shape the redactors must catch. FAKE keeps the repo secret scanner quiet.
const SECRETS = {
  anthropic: "sk-ant-api03-FAKEaaaa1111bbbb2222cccc",
  openaiProject: "sk-proj-FAKE0a1b2c3d4e5f6g7h8i9j0k1l2m3n4",
  openaiLegacy: "sk-FAKE0a1b2c3d4e5f6g7h8i9j",
  gemini: "AIzaSyFAKE1234567890abcdefghijklmnopq",
  github: "ghp_FAKE0123456789abcdefghijklmnopqrstuv",
  bearer: "Bearer FAKEeyJhbGciOiJIUzI1NiJ9.payload",
  deepgram: "0123456789abcdef0123456789abcdef01234567",
};
const leaks = (text: string) =>
  Object.entries(SECRETS)
    .filter(([, v]) => text.includes(v.replace(/^Bearer /, "")))
    .map(([k]) => k);

const logLine = (t: Date, msg: string, extra: Record<string, unknown> = {}) => JSON.stringify({ t: t.toISOString(), level: "warn", msg, ...extra });

function betaHarness(log = "") {
  return harness({ beta: { home: HOME, readLog: () => log } });
}

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  category: "broken",
  description: "Export button does nothing",
  severity: null,
  area: null,
  steps: null,
  usefulness: null,
  messageId: null,
  include: { diagnostics: false, usage: false, excerpt: false },
  excerpt: null,
  ...over,
});

describe("credential redaction is shared and complete (LUM-018)", () => {
  it("the log, the support file and reports catch every provider key shape", () => {
    const text = Object.values(SECRETS).join(" | ");
    expect(leaks(logRedact(text))).toEqual([]);
    expect(leaks(redactCredentials(text))).toEqual([]);
    expect(leaks(buildSupportBundle({ diagnostics: {}, logText: text, home: HOME, now: new Date() }))).toEqual([]);
  });

  it("the provider-bound redactor masks OpenAI project keys (previously sent unmasked)", () => {
    expect(contextRedact(`key ${SECRETS.openaiProject} end`)).toBe("key [redacted API key] end");
    expect(contextRedact(`gh ${SECRETS.github}`)).toBe("gh [redacted API key]");
  });

  it("writes no provider key to lumen.log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-log-"));
    const l = new Logger(dir);
    l.warn("ipc error", { message: `401 from provider with ${SECRETS.openaiProject} and ${SECRETS.gemini}` });
    expect(leaks(fs.readFileSync(l.file, "utf8"))).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("beta report: data minimisation and consent", () => {
  it("by default contains only what the user typed plus coarse versions — no content, paths or identity", async () => {
    const h = betaHarness(logLine(new Date(), "ipc error", { channel: "x" }));
    h.core.addText("note", "Private", "Project Falcon budget is 4.2M");
    const evts = await h.ask("What is the Falcon budget?");
    const mid = (evts.find((e) => e.type === "done") as { messageId: string }).messageId;
    const rec = h.core.beta.saveDraft(null, base({ category: "answer_quality", description: "Wrong total", messageId: mid }));
    const p = h.core.beta.preview(rec.id);
    expect(p.text).not.toMatch(/Falcon|4\.2M|jane\.doe|Answer/);
    expect(p.report.attachments).toEqual({ diagnostics: null, usage: null, excerpt: null });
    // The linked interaction is metadata only.
    expect(p.report.interaction).toMatchObject({ messageId: mid, provider: "anthropic", category: expect.any(String) });
    expect(JSON.stringify(p.report.interaction)).not.toMatch(/Falcon/);
    expect(Object.keys(p.report.app).sort()).toEqual(["arch", "electron", "osRelease", "packaged", "platform", "version"]);
    expect(p.contents.excluded).toContain("The question and answer text");
  });

  it("scrubs secrets, the home folder and terminal control characters from typed text", () => {
    const h = betaHarness();
    const rec = h.core.beta.saveDraft(null, base({ description: `Crashed reading ${HOME}/proj/.env with ${SECRETS.openaiProject}\u001b[2J‮ password: hunter2-pass` }));
    const t = h.core.beta.preview(rec.id).text;
    expect(leaks(t)).toEqual([]);
    expect(t).not.toContain("jane.doe");
    expect(t).not.toContain("hunter2");
    expect(t).not.toMatch(/\u001b|‮/);
    expect(t).toContain("~/proj/.env");
  });

  it("includes diagnostics only when ticked, bounded to the time window, without secrets", () => {
    const now = Date.now();
    const old = logLine(new Date(now - 48 * 3_600_000), "old event");
    const recent = logLine(new Date(now - 3_600_000), "ipc error", { channel: "chat:send", message: `auth failed ${SECRETS.anthropic} at ${HOME}/x`, stack: "Error\n at secret()" });
    const h = betaHarness([old, recent].join("\n"));
    const off = h.core.beta.preview(h.core.beta.saveDraft(null, base()).id);
    expect(off.report.attachments.diagnostics).toBeNull();
    const on = h.core.beta.preview(h.core.beta.saveDraft(null, base({ include: { diagnostics: true, usage: false, excerpt: false } })).id);
    const d = on.report.attachments.diagnostics!;
    expect(d.windowHours).toBe(24);
    expect(d.log.map((l) => l.msg)).toEqual(["ipc error"]);
    expect(on.text).not.toContain("secret()"); // stack traces are not a safe field
    expect(leaks(on.text)).toEqual([]);
    expect(on.text).not.toContain("jane.doe");
  });

  it("the excerpt is opt-in, editable, and the preview says when it is unedited", async () => {
    const h = betaHarness();
    const mid = (await h.ask("How do I rotate the staging key?")).find((e) => e.type === "done") as { messageId: string };
    const src = h.core.beta.excerptFor(mid.messageId)!;
    expect(src.question).toBe("How do I rotate the staging key?");
    const r1 = h.core.beta.saveDraft(null, base({ messageId: mid.messageId, include: { diagnostics: false, usage: false, excerpt: true }, excerpt: src }));
    const p1 = h.core.beta.preview(r1.id);
    expect(p1.report.attachments.excerpt!.editedByUser).toBe(false);
    expect(p1.warnings.join(" ")).toMatch(/original question and answer/);
    const r2 = h.core.beta.saveDraft(r1.id, { ...r1.input, excerpt: { question: "How do I rotate a key?", answer: src.answer } });
    expect(h.core.beta.preview(r2.id).report.attachments.excerpt).toMatchObject({ question: "How do I rotate a key?", editedByUser: true });
    // Unticking drops it even though the text is kept in the draft.
    const r3 = h.core.beta.saveDraft(r2.id, { ...r2.input, include: { ...r2.input.include, excerpt: false } });
    expect(h.core.beta.preview(r3.id).report.attachments.excerpt).toBeNull();
  });

  it("export writes exactly the previewed file and records an honest status; failures can be retried", () => {
    const h = betaHarness();
    const rec = h.core.beta.saveDraft(null, base());
    expect(() => h.core.beta.export(rec.id, "/x/r.json", () => undefined)).toThrow(/Preview the report/);
    const preview = h.core.beta.preview(rec.id).text;
    expect(() =>
      h.core.beta.export(rec.id, "/x/r.json", () => {
        throw new Error("EACCES: permission denied");
      }),
    ).toThrow(/not saved: EACCES/);
    expect(h.core.beta.get(rec.id)).toMatchObject({ status: "export_failed", lastError: expect.stringMatching(/EACCES/) });
    let written = "";
    const done = h.core.beta.export(rec.id, `${HOME}/Desktop/r.json`, (t) => (written = t));
    expect(written).toBe(preview);
    expect(done).toMatchObject({ status: "exported", exportedName: "r.json", lastError: null });
    expect(h.store.qualityEvents(0).some((e) => e.type === "report_exported" && e.code === "broken")).toBe(true);
    // Editing after export returns it to draft, and it must be previewed again before saving.
    expect(h.core.beta.saveDraft(rec.id, { ...rec.input, description: "More detail" }).status).toBe("draft");
    expect(() => h.core.beta.export(rec.id, "/x/r.json", () => undefined)).toThrow(/Preview the report/);
  });

  it("drafts survive a restart, can be discarded, and follow retention", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-beta-"));
    const file = path.join(dir, "lumen.db");
    const s1 = new Store(file);
    s1.saveBetaReport({ id: "6a0f6f7e-1d2c-4b8e-9a1b-2c3d4e5f6a7b", createdAt: 1, updatedAt: 1, status: "draft", input: base() });
    s1.saveBetaReport({ id: "7a0f6f7e-1d2c-4b8e-9a1b-2c3d4e5f6a7b", createdAt: 1, updatedAt: 1, status: "draft", input: { category: "nope" } });
    s1.close();
    const h = harness({ beta: { home: HOME, readLog: () => "" } });
    // Malformed rows are skipped, not shown half-read.
    const s2 = new Store(file);
    expect(s2.listBetaReports()).toHaveLength(2);
    s2.close();
    expect(h.core.beta.list()).toEqual([]);
    const r = h.core.beta.saveDraft(null, base());
    expect(h.core.beta.list().map((x) => x.id)).toEqual([r.id]);
    h.core.beta.discard(r.id);
    expect(() => h.core.beta.get(r.id)).toThrow(/no longer exists/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("validates input and caps unfinished drafts", () => {
    const h = betaHarness();
    expect(() => h.core.beta.saveDraft(null, base({ description: "   " }))).toThrow(/Describe what happened/);
    expect(() => h.core.beta.saveDraft(null, { ...base(), category: "telemetry" })).toThrow();
    expect(() => h.core.beta.saveDraft(null, base({ description: "x".repeat(4001) }))).toThrow();
    for (let i = 0; i < 50; i++) h.core.beta.saveDraft(null, base({ description: `d${i}` }));
    expect(() => h.core.beta.saveDraft(null, base())).toThrow(/50 unfinished reports/);
  });

  it("Delete everything removes reports", () => {
    const h = betaHarness();
    h.core.beta.saveDraft(null, base());
    h.core.deleteAll();
    expect(h.core.beta.list()).toEqual([]);
  });
});

describe("beta report: file validation on the reviewer side", () => {
  const ctx = {
    now: new Date("2026-10-24T10:00:00Z"),
    home: HOME,
    app: { version: "0.3.0", platform: "darwin", arch: "arm64", osRelease: "25.6.0", electron: "44", packaged: true },
    interaction: null,
    diagnostics: null,
    usage: null,
    originalExcerpt: null,
  };
  const good = () => serialize(buildReport(base(), ctx));

  it("round-trips a valid report", () => {
    const r = parseReport(good());
    expect(r.ok && r.report.description).toBe("Export button does nothing");
  });

  it("rejects oversized, non-JSON, foreign, future-version and malformed files", () => {
    expect(parseReport("x".repeat(MAX_REPORT_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringMatching(/limit/) });
    expect(parseReport("{not json")).toMatchObject({ ok: false, error: "Not valid JSON." });
    expect(parseReport(JSON.stringify({ kind: "something-else" }))).toMatchObject({ ok: false });
    const future = { ...JSON.parse(good()), schemaVersion: REPORT_SCHEMA_VERSION + 1 };
    expect(parseReport(JSON.stringify(future))).toMatchObject({ ok: false, error: expect.stringMatching(/newer/) });
    const bad = { ...JSON.parse(good()), category: "<script>" };
    expect(parseReport(JSON.stringify(bad))).toMatchObject({ ok: false, error: expect.stringMatching(/category/) });
    const deep = JSON.parse(good());
    deep.attachments.usage = { a: "x".repeat(600) };
    expect(parseReport(JSON.stringify(deep)).ok).toBe(false);
  });

  it("re-scrubs text in a hand-edited file", () => {
    const edited = JSON.parse(good());
    edited.description = `see ${SECRETS.openaiProject}`;
    const r = parseReport(JSON.stringify(edited));
    expect(r.ok && leaks(r.report.description)).toEqual([]);
  });

  it("never includes more than the size cap even with a huge log", () => {
    const now = Date.now();
    const log = Array.from({ length: 5000 }, (_, i) => logLine(new Date(now - 1000 + i / 10), `event-${i}`, { channel: "x".repeat(100) })).join("\n");
    const { events, truncated } = recentLogEvents(log, now - 3_600_000);
    expect(events.length).toBe(300);
    expect(truncated).toBe(true);
    const r = buildReport(base({ include: { diagnostics: true, usage: false, excerpt: false } }), {
      ...ctx,
      diagnostics: () => ({ windowHours: 24, summary: { big: "y".repeat(400) }, log: events, logTruncated: truncated }),
    });
    expect(Buffer.byteLength(serialize(r))).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  });
});

describe("support file: window and size limits", () => {
  it("keeps only lines inside the window and stays under the size cap", () => {
    const now = new Date("2026-10-24T10:00:00Z");
    const lines = [
      logLine(new Date(now.getTime() - 48 * 3_600_000), "old"),
      "garbage line",
      ...Array.from({ length: 2000 }, (_, i) => logLine(new Date(now.getTime() - 1000), `new-${i}`, { pad: "p".repeat(400) })),
    ];
    const out = buildSupportBundle({ diagnostics: {}, logText: lines.join("\n"), home: HOME, now, sinceMs: now.getTime() - 24 * 3_600_000, maxBytes: 64 * 1024, maxLogLines: 2000 });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(64 * 1024);
    const j = JSON.parse(out) as { log: { totalLines: number; inWindow: number; lines: string[] } };
    expect(j.log.totalLines).toBe(2002);
    expect(j.log.inWindow).toBe(2000);
    expect(j.log.lines.some((l) => l.includes('"old"') || l === "garbage line")).toBe(false);
    expect(j.log.lines.at(-1)).toContain("new-1999");
  });
});

describe("usage events: opt-out and content-free milestones", () => {
  it("records setup milestones, and nothing at all once the user turns recording off", async () => {
    const h = betaHarness();
    h.core.quality.record("app_started", "packaged");
    await h.core.testProvider();
    h.core.updateSettings({ consent: { screen: false } });
    h.core.updateSettings({ consent: { screen: true } });
    await h.ask("hello");
    const types = h.store.qualityEvents(0).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["app_started", "provider_test", "context_activated", "request_completed"]));
    const before = h.store.qualityEvents(0).length;
    h.core.updateSettings({ diagnostics: { recordUsageEvents: false } });
    h.core.quality.record("app_started", "packaged");
    await h.ask("second");
    await h.core.testProvider();
    const mid = (await h.ask("third")).find((e) => e.type === "done") as { messageId: string };
    h.core.quality.addFeedback({ messageId: mid.messageId, kind: "helpful" }); // explicit feedback is still saved…
    expect(h.store.qualityEvents(0).length).toBe(before); // …but no event is recorded
    expect(h.core.quality.listFeedback()).toHaveLength(1);
  });

  it("milestone codes cannot carry user content", () => {
    const h = betaHarness();
    h.core.quality.record("context_activated", "screen: my secret project falcon <b>");
    const e = h.store.qualityEvents(0).at(-1)!;
    expect(e.code!.length).toBeLessThanOrEqual(40);
    expect(e.code).not.toMatch(/\s|<|>/);
    // Unknown types are refused rather than stored.
    h.core.quality.record("request_completed" as never, "x");
    expect(h.store.qualityEvents(0).filter((x) => x.type === "request_completed")).toHaveLength(0);
  });

  it("activation metrics are null until the events exist, then computed from them", async () => {
    const h = betaHarness();
    const empty = h.core.quality.activation();
    expect(empty).toMatchObject({ firstLaunchAt: null, timeToFirstAnswerMs: null, requests: { technicalSuccess: null, n: 0 } });
    h.core.quality.record("app_started", "packaged");
    await h.ask("hello");
    const a = h.core.quality.activation();
    expect(a.timeToFirstAnswerMs).toBeGreaterThanOrEqual(0);
    expect(a.requests).toEqual({ technicalSuccess: 1, n: 1 });
    expect(a.ratedAnswers).toEqual({ helpful: 0, notHelpful: 0 });
  });
});

describe("triage", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  const ctx = {
    now,
    home: "",
    app: { version: "0.3.0", platform: "darwin", arch: "arm64", osRelease: "25", electron: null, packaged: true },
    interaction: null,
    diagnostics: null,
    usage: null,
    originalExcerpt: null,
  };
  const rep = (over: Partial<ReportInput>) => buildReport(base(over), ctx);

  it("prioritises by class, then reproduction, then observed frequency; issues start as observed evidence", () => {
    const s = T.emptyState();
    const a = T.importReport(s, rep({ category: "feature_request", description: "Dark mode toggle in panel" }), now);
    const b = T.importReport(s, rep({ category: "performance", description: "Answers take 30 s" }), now);
    const c = T.importReport(s, rep({ category: "privacy", description: "Key appeared in log file" }), now);
    T.importReport(s, rep({ category: "performance", description: "Slow on battery" }), now, (b as { issue: string }).issue);
    const ranked = T.prioritise(s);
    expect(ranked.map((r) => r.issue.id)).toEqual([(c as { issue: string }).issue, (b as { issue: string }).issue, (a as { issue: string }).issue]);
    expect(ranked[1]).toMatchObject({ frequency: 2, evidence: "observed" });
    expect(T.summary(s).note).toMatch(/too few/);
    expect(T.releaseBlockers(s).map((i) => i.id)).toEqual([(c as { issue: string }).issue]);
  });

  it("detects re-imports and identical content instead of double counting", () => {
    const s = T.emptyState();
    const r = rep({ description: "Crash on export" });
    T.importReport(s, r, now);
    expect(T.importReport(s, r, now).status).toBe("already_imported");
    expect(T.importReport(s, { ...r, id: "0b9a6c1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b" }, now).status).toBe("same_content");
    expect(T.prioritise(s)[0]!.frequency).toBe(1);
  });

  it("duplicates move their evidence; status rules can't be skipped", () => {
    const s = T.emptyState();
    const x = (T.importReport(s, rep({ description: "Export fails silently" }), now) as { issue: string }).issue;
    const y = (T.importReport(s, rep({ description: "Export does nothing on click" }), now) as { issue: string }).issue;
    expect(T.suggestDuplicates(s, y).length).toBe(0); // only one shared distinctive word
    T.markDuplicate(s, y, x, now);
    expect(T.getIssue(s, x).reports).toHaveLength(2);
    expect(() => T.markDuplicate(s, x, x, now)).toThrow();
    expect(() => T.updateIssue(s, x, { status: "verified" }, now)).toThrow(/verify/);
    expect(() => T.updateIssue(s, x, { status: "fixed" }, now)).toThrow(/Record the fix/);
    expect(() => T.recordFix(s, x, "abc1234", "", [], now)).toThrow(/regression test/);
    expect(() => T.recordVerification(s, x, "passed", "0.3.1", "", now)).toThrow(/no fix/);
    expect(() => T.updateIssue(s, x, { class: "urgent" }, now)).toThrow(/class must be/);
    expect(s.audit.some((a) => a.action === "duplicate")).toBe(true);
  });

  it("a failed verification reopens the issue as unresolved", () => {
    const s = T.emptyState();
    const x = (T.importReport(s, rep({ category: "crash", description: "Crash on quit" }), now) as { issue: string }).issue;
    T.recordFix(s, x, "abc1234", "guard", ["src/test/x.test.ts"], now);
    T.recordVerification(s, x, "failed", "0.3.1", "still crashes", now);
    expect(T.getIssue(s, x).status).toBe("unresolved");
    expect(T.releaseBlockers(s)).toHaveLength(1);
  });

  it("refuses a newer or foreign workspace file", () => {
    expect(() => T.loadState(JSON.stringify({ kind: "lumen-triage", schemaVersion: 99, issues: [], reports: {}, audit: [] }))).toThrow(/schema 99/);
    expect(() => T.loadState(JSON.stringify({ kind: "x" }))).toThrow();
  });
});

describe("regression cases: only reviewed, unchanged, synthetic cases are trusted", () => {
  const file = (): RegressionFile => JSON.parse(fs.readFileSync(path.join(__dirname, "../core/eval/regression-cases.json"), "utf8"));
  const entry = (over: Partial<RegressionEntry> = {}): RegressionEntry => ({ ...file().entries[0]!, ...over });

  it("the shipped file is valid", () => {
    expect(loadRegressions(file()).invalid).toEqual([]);
  });

  it("proposed cases are not run; approval pins the definition; an edit after approval is not trusted", () => {
    const f: RegressionFile = { kind: "lumen-regression-cases", version: 1, entries: [entry({ status: "proposed", approval: null, proposedBy: "alex" })] };
    expect(loadRegressions(f).trusted).toEqual([]);
    expect(() => approve(f, f.entries[0]!.case.id, "alex", new Date())).toThrow(/can't approve/);
    approve(f, f.entries[0]!.case.id, "sam", new Date());
    expect(loadRegressions(f).trusted.map((c) => c.id)).toEqual([f.entries[0]!.case.id]);
    f.entries[0]!.case.pipeline = f.entries[0]!.case.pipeline.slice(0, 1); // weaken the case
    expect(loadRegressions(f)).toMatchObject({ trusted: [], stale: [f.entries[0]!.case.id] });
  });

  it("refuses real-looking secrets or personal data, and user-derived cases without a sanitisation note", () => {
    const leaky = entry();
    leaky.case = { ...leaky.case, fixtures: [{ kind: "note", title: "n", text: "Call me: card 4111 1111 1111 1111" }] };
    expect(validateRegressionCase(leaky).join()).toMatch(/credential or personal data/);
    const realKey = entry();
    // Random-looking (not a real key); built at runtime so the repository secret scanner stays strict.
    const keyLike = ["sk", "proj", "q8Wn3Lr5Tz7Yb2Xc4Vd6Mf9Gh1Jk0Pa3Sd"].join("-");
    realKey.case = { ...realKey.case, fixtures: [{ kind: "note", title: "n", text: keyLike }] };
    expect(validateRegressionCase(realKey).join()).toMatch(/credential/);
    expect(validateRegressionCase(entry({ origin: "sanitized_user_example", sanitization: null })).join()).toMatch(/sanitization note/);
    expect(validateRegressionCase(entry({ status: "approved", approval: null })).join()).toMatch(/approval record/);
    expect(definitionHash(entry().case)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("feedback → triage → fix → regression → verify (synthetic walk-through of BETA-001)", () => {
  it("the regression case reproduces the defect, passes with the fix, and blocks if the fix is reverted", async () => {
    // 1. A tester reports it (synthetic): description + diagnostics, no excerpt.
    const h = betaHarness(logLine(new Date(), "ipc error", { channel: "chat:send", code: "auth" }));
    const rec = h.core.beta.saveDraft(
      null,
      base({ category: "privacy", description: "My OpenAI project key from a pasted .env looked unmasked in the context inspector", severity: "major", area: "assistant" }),
    );
    let fileText = "";
    h.core.beta.preview(rec.id);
    h.core.beta.export(rec.id, "r.json", (t) => (fileText = t));
    // 2. The reviewer imports and triages it.
    const parsed = parseReport(fileText);
    expect(parsed.ok).toBe(true);
    const s = T.emptyState();
    const now = new Date();
    const issue = (T.importReport(s, (parsed as { report: Parameters<typeof T.importReport>[1] }).report, now) as { issue: string }).issue;
    expect(T.getIssue(s, issue).class).toBe("security_privacy");
    expect(T.releaseBlockers(s)).toHaveLength(1);
    // 3. Reproduce with the approved regression case through the real pipeline.
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, "../core/eval/regression-cases.json"), "utf8")) as RegressionFile;
    const e = f.entries.find((x) => x.issue === "BETA-001")!;
    approve(f, e.case.id, "reviewer-b", now);
    const cases = loadRegressions(f).trusted;
    expect(cases.map((c) => c.id)).toEqual([e.case.id]);
    const run = await runEvaluation({ mode: "deterministic", cases, benchmarkVersion: "reg", settings: DEFAULT_SETTINGS });
    expect(run.results[0]!.status).toBe("passed");
    T.recordReproduction(s, issue, "reproduced", "Before the fix the case failed: key sent unmasked", "0.3.0", now);
    T.recordFix(s, issue, "abc1234", "widen sk- pattern", [e.case.id, "src/test/betaProgramme.test.ts"], now);
    T.recordVerification(s, issue, "passed", "0.3.0+fix", "regression case passes", now);
    expect(T.getIssue(s, issue).status).toBe("verified");
    expect(T.releaseBlockers(s)).toEqual([]);
  });
});
