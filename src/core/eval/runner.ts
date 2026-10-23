// Evaluation runner. Each case runs through the real AppCore pipeline (turn understanding, context
// gathering and ranking, prompt building, routing, provider call, verification) in an isolated
// in-memory store, so benchmark data never touches the user's database.
//
// Deterministic mode uses a scripted provider and never reports scripted text as model output.
// Live mode uses the user's configured provider and must be started explicitly by the caller.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { AppCore } from "../app";
import type { PipelineOverrides } from "../chatService";
import { DEFAULT_BUDGET } from "../context/promptBuilder";
import { Store } from "../storage/db";
import { estimateCostUsd, hasPricing } from "../providers/pricing";
import type { AIProvider } from "../providers/types";
import { applySettingsPatch } from "../../shared/settingsSchema";
import type { ChatEvent, Settings } from "../../shared/types";
import { promptById, shortHash } from "./prompts";
import { RecordingProvider, ScriptedProvider } from "./providers";
import { checkResults, emptyCounts, summarize, type Observation } from "./scoring";
import { EVAL_SCHEMA_VERSION, METRIC_DEFINITIONS, type CaseResult, type EvalCase, type EvalRun, type RunConfig, type RunLimits, type Variant } from "./types";

export const DEFAULT_LIMITS: RunLimits = { maxCases: 100, concurrency: 2, maxOutputTokens: 1500, maxCostUsd: 1, caseTimeoutMs: 90_000 };
export const HARD_LIMITS: RunLimits = { maxCases: 500, concurrency: 4, maxOutputTokens: 8000, maxCostUsd: 25, caseTimeoutMs: 300_000 };

export interface RunOptions {
  mode: "deterministic" | "live";
  cases: EvalCase[];
  benchmarkVersion: string;
  /** The user's settings; only provider, personalization and technical preferences are used. */
  settings: Settings;
  /** Builds the user's configured provider (live mode). Never called in deterministic mode. */
  liveProvider?: () => AIProvider | null | Promise<AIProvider | null>;
  variant?: Variant;
  repeat?: number;
  limits?: Partial<RunLimits>;
  label?: string;
  signal?: AbortSignal;
  onProgress?: (run: EvalRun) => void;
  now?: () => number;
  experiment?: EvalRun["experiment"];
  /** Local runtime details (version, loaded models and memory) recorded with local-model runs. */
  describeLocal?: () => Promise<{ runtimeVersion: string | null; loaded: { name: string; sizeBytes: number; vramBytes: number }[] }>;
}

export function caseHash(c: EvalCase): string {
  return shortHash(JSON.stringify(c));
}

function clampLimits(l: Partial<RunLimits> = {}): RunLimits {
  // Undefined or non-numeric fields fall back to the defaults instead of overriding them with NaN.
  const given = Object.fromEntries(Object.entries(l).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
  const m = { ...DEFAULT_LIMITS, ...given };
  return {
    maxCases: Math.max(1, Math.min(HARD_LIMITS.maxCases, Math.floor(m.maxCases))),
    concurrency: Math.max(1, Math.min(HARD_LIMITS.concurrency, Math.floor(m.concurrency))),
    maxOutputTokens: Math.max(64, Math.min(HARD_LIMITS.maxOutputTokens, Math.floor(m.maxOutputTokens))),
    maxCostUsd: Math.max(0, Math.min(HARD_LIMITS.maxCostUsd, m.maxCostUsd)),
    caseTimeoutMs: Math.max(1000, Math.min(HARD_LIMITS.caseTimeoutMs, Math.floor(m.caseTimeoutMs))),
  };
}

/** Rough worst-case estimate for one live case: prompt size plus the output cap. */
export function estimateCaseCostUsd(c: EvalCase, model: string, maxOutputTokens: number): number | null {
  if (!hasPricing(model)) return null;
  const chars = c.request.question.length + JSON.stringify(c.fixtures).length + 6000; // + system prompt
  return estimateCostUsd(model, { inputTokens: Math.ceil(chars / 3.5), outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

export function estimateRunCostUsd(cases: EvalCase[], model: string, maxOutputTokens: number, repeat = 1): { usd: number; known: boolean } {
  let usd = 0;
  for (const c of cases) {
    const e = estimateCaseCostUsd(c, model, maxOutputTokens);
    if (e == null) return { usd: 0, known: false };
    usd += e * repeat;
  }
  return { usd: Math.round(usd * 1e4) / 1e4, known: true };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: { type: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "[image]")).join("\n");
}

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

/** Seed an isolated AppCore with the case fixtures. */
function setupCase(c: EvalCase, provider: AIProvider | null, baseSettings: Settings, overrides: PipelineOverrides, clock: { t: number }) {
  const store = new Store(":memory:");
  const chat: ChatEvent[] = [];
  const settings = applySettingsPatch(baseSettings, {
    onboardingComplete: true,
    activeSessionId: null,
    consent: { screen: true, microphone: true, systemAudio: false },
    screen: { requirePreview: false, ocr: false },
    assistant: { useKnowledgeBase: true, useConversationHistory: true, useProjectMemory: true },
    privacy: { redactSensitive: true },
    // The case's provider is injected as the selected one (even a local model), so the hybrid
    // router has exactly one target and never probes the user's runtime.
    provider: { dailySpendLimitUsd: 0, ...(baseSettings.provider.kind === "ollama" ? { kind: "anthropic" } : {}) },
    // The provider under test is injected directly; hybrid routing, privacy restriction and the
    // user's usage limits must not change which model a benchmark case measures.
    inference: { mode: "manual", privacyRestricted: false, responseCache: false, local: { embeddingModel: "" } },
    limits: { requestsPerSession: 0, costPerSessionUsd: 0 },
    ...(c.settings ?? {}),
  });
  const core = new AppCore(
    {
      store,
      secrets: { get: () => null, has: () => false },
      ocr: null,
      emitChat: (e) => chat.push(e),
      emitTranscript: () => undefined,
      emitApp: () => undefined,
      providerFactory: () => provider,
      now: () => clock.t,
      ocrWaitMs: 0,
      devModeAllowed: true,
      pipelineOverrides: overrides,
    },
    settings,
  );
  const session = core.createSession({ title: "Evaluation", type: c.request.mode ?? "general" });
  let conversationId: string | null = null;
  for (const f of c.fixtures) {
    switch (f.kind) {
      case "note":
      case "document":
      case "clipboard":
      case "selected_text":
        core.addText(f.kind, f.title, f.text, { pinned: f.pinned });
        break;
      case "ocr": {
        const rec = core.engine.ingest({ sessionId: session.id, source: "ocr", title: f.title, text: f.text, confidence: f.confidence ?? 0.95, permission: "screen", ocr: "done" });
        if (f.ageMinutes) Object.assign(rec, { createdAt: clock.t - f.ageMinutes * 60_000 });
        break;
      }
      case "transcript": {
        const t = store.createTranscriptSession(session.id, f.title, "eval", clock.t - 600_000);
        f.lines.forEach((l, i) => store.addSegment({ sessionId: t.id, startMs: i * 4000, endMs: i * 4000 + 3500, speaker: l.speaker, channel: null, text: l.text, confidence: 0.95 }));
        store.endTranscriptSession(t.id, clock.t - 60_000);
        break;
      }
      case "knowledge":
        core.addKnowledgeText(f.title, f.text, "session");
        break;
      case "memory":
        core.memory.add(f.memoryKind, f.text);
        break;
      case "turns": {
        const conv = store.createConversation(session.id, f.turns[0]?.question.slice(0, 60) ?? "Earlier", session.type, clock.t - 300_000);
        conversationId = conv.id;
        f.turns.forEach((t, i) => {
          store.addMessage({ conversationId: conv.id, role: "user", content: t.question, references: [], meta: {}, createdAt: clock.t - 300_000 + i * 2000 });
          store.addMessage({ conversationId: conv.id, role: "assistant", content: t.answer, references: [], meta: {}, createdAt: clock.t - 299_000 + i * 2000 });
        });
        break;
      }
      case "other_conversation": {
        const conv = store.createConversation(session.id, f.question.slice(0, 60), session.type, clock.t - 3_600_000);
        store.addMessage({ conversationId: conv.id, role: "user", content: f.question, references: [], meta: {}, createdAt: clock.t - 3_600_000 });
        store.addMessage({ conversationId: conv.id, role: "assistant", content: f.answer, references: [], meta: {}, createdAt: clock.t - 3_599_000 });
        break;
      }
      case "other_session": {
        const other = store.createSession({ title: "Another session", type: "general" });
        core.engine.ingest({ sessionId: other.id, source: "note", title: f.title, text: f.text });
        break;
      }
    }
  }
  return { store, core, chat, session, conversationId };
}

/** Run one case once. Never throws: failures inside the pipeline become a recorded result. */
export async function runCase(
  c: EvalCase,
  opts: { mode: "deterministic" | "live"; settings: Settings; provider: AIProvider | null; overrides: PipelineOverrides; timeoutMs: number; attempt: number; signal?: AbortSignal },
): Promise<CaseResult> {
  const base: Omit<CaseResult, "status" | "checks" | "outcome"> = {
    caseId: c.id,
    caseHash: caseHash(c),
    category: c.category,
    attempt: opts.attempt,
    model: null,
    warnings: [],
    verificationFlags: [],
    latency: { ttftMs: null, totalMs: 0 },
    retries: 0,
  };
  if (opts.mode === "deterministic" && c.liveOnly) return { ...base, status: "skipped", reason: "Needs a real model; run in live mode.", checks: [], outcome: "not_run" };
  if (opts.mode === "live" && c.deterministicOnly)
    return { ...base, status: "skipped", reason: "Pipeline-only case (scripted provider behaviour); runs in deterministic mode.", checks: [], outcome: "not_run" };

  const clock = { t: T0 };
  const recorder =
    opts.mode === "deterministic" ? (c.script?.noProvider ? null : new ScriptedProvider(c.script)) : opts.provider ? new RecordingProvider(opts.provider, opts.settings.provider.maxTokens) : null;
  let env: ReturnType<typeof setupCase>;
  try {
    env = setupCase(c, recorder, opts.settings, opts.overrides, clock);
  } catch (e) {
    return { ...base, status: "inconclusive", reason: `Fixture setup failed: ${(e as Error).message}`, checks: [], outcome: "not_run" };
  }
  const requestId = randomUUID();
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    env.core.chat.cancel(requestId);
  }, opts.timeoutMs);
  const onAbort = () => env.core.chat.cancel(requestId);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.mode === "deterministic" && c.script?.cancelAfterMs !== undefined) cancelTimer = setTimeout(() => env.core.chat.cancel(requestId), c.script.cancelAfterMs);
  try {
    await env.core.send({
      requestId,
      conversationId: env.conversationId,
      text: c.request.question,
      style: c.request.style ?? "quick",
      tone: "neutral",
      includeLiveTranscript: c.request.includeTranscript ?? true,
      depth: c.request.depth,
    });
  } catch (e) {
    clearTimeout(timer);
    env.store.close();
    return { ...base, status: "inconclusive", reason: `Runner error: ${(e as Error).message}`, checks: [], outcome: "not_run" };
  } finally {
    clearTimeout(timer);
    if (cancelTimer) clearTimeout(cancelTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  const totalMs = Math.round(performance.now() - started);
  const events = env.chat.filter((e) => e.requestId === requestId);
  const start = events.find((e) => e.type === "start");
  const done = events.find((e) => e.type === "done");
  const err = events.find((e) => e.type === "error");
  const cancelled = events.find((e) => e.type === "cancelled");
  const answer = events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  const req = recorder?.requests.at(-1);
  const system = req ? req.system.map((b) => b.text).join("\n\n") : "";
  const user = req ? textOf(req.messages.at(-1)?.content) : "";
  const historyMessages = req ? req.messages.length - 1 : 0;
  const outcome: CaseResult["outcome"] = timedOut ? "timeout" : done ? "done" : err ? "error" : cancelled ? "cancelled" : "not_run";
  const savedAnswer = done ? (env.store.getMessage(done.messageId)?.content ?? answer) : answer;
  env.store.close();

  const userStopped = opts.signal?.aborted && !timedOut;
  const result: CaseResult = {
    ...base,
    status: "running",
    outcome,
    errorCode: err?.code,
    model: start?.provider.model ?? null,
    intent: start ? { category: start.intent.category, relation: start.intent.relation, ambiguous: !!start.intent.ambiguous } : undefined,
    input: req ? { system, user, historyMessages } : undefined,
    output: opts.mode === "live" ? savedAnswer : undefined,
    warnings: start?.warnings ?? [],
    verificationFlags: done?.verification.findings.map((f) => f.check) ?? [],
    latency: { ttftMs: done?.ttftMs ?? null, totalMs },
    usage:
      done && opts.mode === "live"
        ? { inputTokens: done.usage.inputTokens, outputTokens: done.usage.outputTokens, costUsd: hasPricing(start?.provider.model ?? "") ? done.usage.estimatedCostUsd : null }
        : undefined,
    retries: events.filter((e) => e.type === "retrying").length,
    checks: [],
  };
  if (userStopped) return { ...result, status: "inconclusive", reason: "Stopped by the user before the case finished." };
  if (timedOut) return { ...result, status: "inconclusive", reason: `No result within ${opts.timeoutMs} ms.` };

  const obs: Observation = {
    outcome,
    errorCode: err?.code,
    retries: result.retries,
    intent: result.intent,
    system,
    user,
    historyMessages,
    references: start?.references.map((r) => ({ label: r.label, kind: r.kind })) ?? [],
    warnings: result.warnings,
    availabilityTranscript: start?.availability.transcript ?? null,
    verificationFlags: result.verificationFlags,
    answer: savedAnswer,
  };
  const scoped: { scope: "pipeline" | "answer"; check: EvalCase["pipeline"][number] }[] = c.pipeline.map((check) => ({ scope: "pipeline", check }));
  const answerChecks = opts.mode === "live" || c.answerChecksInDeterministic;
  if (answerChecks) scoped.push(...c.answer.map((check) => ({ scope: "answer" as const, check })));
  const checks = checkResults(scoped, obs);

  // A live provider failure means the answer could not be judged, which is not the same as a
  // wrong answer (unless the case expects that failure).
  const expectsError = c.pipeline.some((p) => p.assertion.type === "outcome" && p.assertion.expect !== "done");
  if (opts.mode === "live" && outcome !== "done" && !expectsError) {
    return { ...result, checks, status: "inconclusive", reason: `Provider ${outcome}${err ? `: ${err.code} — ${err.message}` : ""}` };
  }
  if (!checks.length) return { ...result, checks, status: "inconclusive", reason: "No applicable checks for this mode." };
  return { ...result, checks, status: checks.every((x) => x.passed) ? "passed" : "failed" };
}

function limitationsFor(mode: RunConfig["mode"], variant: Variant | undefined): string[] {
  const out = [
    "Checks test behaviours with deterministic assertions (patterns, structure, request contents); they do not prove an answer is fully correct.",
    "Benchmark fixtures are synthetic. Real screens, transcripts and documents are noisier.",
  ];
  if (mode === "deterministic")
    out.push("Deterministic mode uses a scripted provider: it measures how Lumen builds requests and handles outcomes, not answer quality. Answer-quality cases are skipped.");
  else out.push("Live model outputs vary between runs; compare several repeats before drawing conclusions. No LLM judge is used.");
  if (variant?.promptVersion && variant.promptVersion !== "production") out.push(`Uses experimental prompt "${variant.promptVersion}", not the shipped prompt.`);
  return out;
}

/** Run a set of cases with bounded concurrency, budget enforcement and cancellation. */
export async function runEvaluation(o: RunOptions): Promise<EvalRun> {
  const now = o.now ?? Date.now;
  const limits = clampLimits(o.limits);
  const repeat = Math.max(1, Math.min(5, Math.floor(o.repeat ?? 1)));
  const variant = o.variant;
  const prompt = promptById(variant?.promptVersion ?? "production");
  const budgetChars = variant?.contextBudgetChars ?? DEFAULT_BUDGET.maxContextChars;
  const overrides: PipelineOverrides = {
    basePrompt: prompt.id === "production" ? undefined : prompt.text,
    budget: { ...DEFAULT_BUDGET, maxContextChars: budgetChars, maxItemChars: Math.min(DEFAULT_BUDGET.maxItemChars, budgetChars) },
    verification: variant?.verification ?? true,
  };
  let settings = applySettingsPatch(o.settings, { provider: { maxTokens: Math.min(o.settings.provider.maxTokens, limits.maxOutputTokens) } });
  if (variant?.model) settings = applySettingsPatch(settings, { provider: { model: variant.model } });

  let provider: AIProvider | null = null;
  if (o.mode === "live") {
    provider = (await o.liveProvider?.()) ?? null;
    if (!provider || provider.isMock) throw new Error("Live evaluation needs a configured, real AI provider. Development mode cannot be used for live results.");
  }
  const isLocal = provider?.kind === "ollama";
  const model = o.mode === "live" ? (variant?.model ?? (isLocal ? settings.inference.local.model : settings.provider.model)) : "scripted";
  const selected = o.cases.slice(0, limits.maxCases);
  const run: EvalRun = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: randomUUID(),
    createdAt: now(),
    finishedAt: null,
    benchmarkVersion: o.benchmarkVersion,
    status: "running",
    config: {
      mode: o.mode,
      provider: o.mode === "live" ? provider!.kind : "scripted",
      model,
      promptVersion: prompt.id,
      promptHash: shortHash(prompt.text),
      contextBudgetChars: budgetChars,
      verification: overrides.verification !== false,
      repeat,
      concurrency: o.mode === "live" ? limits.concurrency : 1,
      label: o.label?.slice(0, 80),
    },
    limits,
    caseIds: selected.map((c) => c.id),
    results: [],
    summary: {
      counts: emptyCounts(),
      byCategory: {},
      byMetric: {},
      latency: { p50TtftMs: null, p50TotalMs: null, p95TotalMs: null, n: 0 },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true },
    },
    metricDefinitions: METRIC_DEFINITIONS,
    limitations: limitationsFor(o.mode, variant),
    experiment: o.experiment,
  };
  if (o.cases.length > limits.maxCases) run.limitations.push(`Selection capped at ${limits.maxCases} of ${o.cases.length} cases by the run limit.`);
  const publish = () => {
    run.summary = summarize(run.results, run.caseIds, repeat);
    o.onProgress?.(structuredClone(run));
  };

  const queue: { c: EvalCase; attempt: number }[] = [];
  for (let a = 1; a <= repeat; a++) for (const c of selected) queue.push({ c, attempt: a });
  let spent = 0;
  let reserved = 0;
  let stopReason: string | undefined;
  // Local inference has no per-request price, so its "cost" is genuinely zero.
  const pricingKnown = o.mode !== "live" || isLocal || hasPricing(model);
  if (!pricingKnown) run.limitations.push(`No bundled pricing for "${model}": cost is not estimated and the cost limit cannot be enforced; only the case limit (${limits.maxCases}) bounds this run.`);
  const worker = async () => {
    while (queue.length) {
      if (o.signal?.aborted) return;
      if (stopReason) return;
      const next = queue.shift()!;
      // Always enforced in live mode (a limit of 0 means nothing may be spent). Each case reserves
      // its worst-case estimate before starting, so parallel workers cannot overshoot together.
      const est = o.mode === "live" ? (estimateCaseCostUsd(next.c, model, limits.maxOutputTokens) ?? 0) : 0;
      if (o.mode === "live" && pricingKnown && spent + reserved + est > limits.maxCostUsd) {
        stopReason = `Stopped before exceeding the $${limits.maxCostUsd.toFixed(2)} cost limit (spent ≈ $${spent.toFixed(4)}).`;
        queue.unshift(next);
        return;
      }
      reserved += est;
      const r = await runCase(next.c, { mode: o.mode, settings, provider, overrides, timeoutMs: limits.caseTimeoutMs, attempt: next.attempt, signal: o.signal });
      reserved -= est;
      if (r.usage?.costUsd) spent += r.usage.costUsd;
      run.results.push(r);
      publish();
    }
  };
  run.environment = {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1e9) * 10) / 10,
    location: o.mode === "deterministic" ? "none" : isLocal ? "local" : "cloud",
  };
  publish();
  await Promise.all(Array.from({ length: run.config.concurrency }, worker));
  if (isLocal && o.describeLocal) {
    try {
      const d = await o.describeLocal();
      run.environment.runtimeVersion = d.runtimeVersion;
      run.environment.loadedModels = d.loaded;
    } catch {
      run.limitations.push("Could not read the local runtime's memory usage after the run.");
    }
    run.limitations.push("Local results depend on this computer's hardware (recorded under Environment) and on other load during the run.");
  }
  run.finishedAt = now();
  const counts = summarize(run.results, run.caseIds, repeat).counts;
  run.status = o.signal?.aborted ? "cancelled" : stopReason ? "partial" : counts.not_run > 0 || counts.inconclusive > 0 ? "partial" : "complete";
  run.stopReason = o.signal?.aborted ? "Stopped by the user." : stopReason;
  if (run.status === "partial" && !run.stopReason) run.stopReason = counts.inconclusive ? `${counts.inconclusive} case(s) inconclusive.` : "Not every selected case ran.";
  publish();
  return run;
}
