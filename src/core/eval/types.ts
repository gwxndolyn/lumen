// Evaluation Lab schemas. Benchmark cases describe behaviours to check, not one preferred wording;
// runs record exactly what was executed so results can be compared and reproduced.

import type { AnswerStyle, AssistantMode, ErrorCode } from "../../shared/types";

export const EVAL_SCHEMA_VERSION = 1;

export type EvalCategory =
  | "context_retrieval"
  | "follow_up"
  | "coding_debugging"
  | "algorithms"
  | "code_review"
  | "research_factual"
  | "meeting_notes"
  | "conflicting_evidence"
  | "prompt_injection"
  | "long_context"
  | "provider_failures"
  | "format_compliance";

export const CATEGORY_LABELS: Record<EvalCategory, string> = {
  context_retrieval: "Context retrieval and relevance",
  follow_up: "Follow-up understanding",
  coding_debugging: "Coding and debugging",
  algorithms: "Algorithms and data structures",
  code_review: "Code explanation and review",
  research_factual: "Technical research and factual accuracy",
  meeting_notes: "Meeting notes and summarisation",
  conflicting_evidence: "Contradictory or incomplete evidence",
  prompt_injection: "Prompt injection in untrusted context",
  long_context: "Long-context handling",
  provider_failures: "Provider failures and recovery",
  format_compliance: "Output formatting and instruction compliance",
};

/** Separate dimensions; never collapsed into one score. */
export type Metric = "task_completion" | "context_relevance" | "groundedness" | "correctness" | "completeness" | "instruction_compliance" | "reliability" | "safety";

export const METRIC_DEFINITIONS: Record<Metric, string> = {
  task_completion: "The response or pipeline outcome satisfies the case's acceptance criteria.",
  context_relevance: "Useful evidence was selected and irrelevant or out-of-scope evidence was left out.",
  groundedness: "Claims rely on supplied evidence; no citations or sources that were not provided.",
  correctness: "Objectively checkable facts or code properties are right.",
  completeness: "Required elements (code, sections, caveats) are present.",
  instruction_compliance: "The requested format, language, length and constraints were followed.",
  reliability: "Failures are surfaced with the right error, retries and recovery behave as designed.",
  safety: "Untrusted context does not change behaviour or leak into trusted instructions.",
};

export type Fixture =
  | { kind: "note" | "document" | "clipboard" | "selected_text"; title: string; text: string; pinned?: boolean }
  | { kind: "ocr"; title: string; text: string; confidence?: number; ageMinutes?: number }
  | { kind: "transcript"; title: string; lines: { speaker: string; text: string }[] }
  | { kind: "knowledge"; title: string; text: string }
  | { kind: "memory"; memoryKind: "preference" | "convention" | "architecture" | "decision" | "known_issue" | "task"; text: string }
  /** Earlier turns in the same conversation (the question under test is a follow-up). */
  | { kind: "turns"; turns: { question: string; answer: string }[] }
  /** An earlier, separate conversation in the same session (retrievable history). */
  | { kind: "other_conversation"; question: string; answer: string }
  /** A note in a different workspace session. Must never reach this session's request. */
  | { kind: "other_session"; title: string; text: string };

/** Scripted provider behaviour for deterministic mode. Never presented as model output. */
export interface Script {
  /** Canned answer used to exercise post-generation checks; defaults to a neutral placeholder. */
  answer?: string;
  stopReason?: string;
  /** Errors thrown on successive attempts before the answer (or the final error) is returned. */
  errors?: { code: ErrorCode; retryable: boolean; message?: string }[];
  /** Stream this many characters then stall/abort (used with cancel). */
  cancelAfterMs?: number;
  /** Return an empty answer. */
  empty?: boolean;
  /** No provider can be built (e.g. no API key). */
  noProvider?: boolean;
}

export type Assertion =
  // ---- pipeline (deterministic and live) ----
  | { type: "outcome"; expect: "done" | "error" | "cancelled"; code?: ErrorCode }
  | { type: "retries"; min?: number; max?: number }
  | { type: "category"; expect: string }
  | { type: "relation"; expect: string }
  | { type: "ambiguous"; expect: boolean }
  | { type: "sent_contains"; text: string; ignoreCase?: boolean }
  | { type: "sent_not_contains"; text: string; ignoreCase?: boolean }
  | { type: "system_contains"; text: string; ignoreCase?: boolean }
  | { type: "system_not_contains"; text: string; ignoreCase?: boolean }
  | { type: "sources"; kind?: string; min?: number; max?: number }
  | { type: "warning"; pattern: string }
  | { type: "no_warning" }
  | { type: "history_messages"; min?: number; max?: number }
  | { type: "sent_chars"; max: number }
  | { type: "availability_transcript"; expect: "live" | "none" }
  | { type: "verify_flags"; check: string; expect: boolean }
  // ---- answer (live mode; applied to the canned answer only when the case says so) ----
  | { type: "answer_matches"; pattern: string; flags?: string }
  | { type: "answer_not_matches"; pattern: string; flags?: string }
  | { type: "answer_code_lang"; lang: string }
  | { type: "answer_has_code"; expect: boolean }
  | { type: "answer_cites"; min?: number }
  | { type: "answer_no_unknown_citations" }
  | { type: "answer_max_words"; max: number }
  | { type: "answer_parses_json" };

export type AssertionScope = "pipeline" | "answer";

export interface Check {
  assertion: Assertion;
  metric: Metric;
  /** Human-readable acceptance criterion or failure condition. */
  describe: string;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  difficulty: "easy" | "medium" | "hard";
  title: string;
  request: { question: string; mode?: AssistantMode; style?: AnswerStyle; depth?: "quick" | "balanced" | "deep"; includeTranscript?: boolean };
  fixtures: Fixture[];
  /** Acceptance criteria checked on the request Lumen built and the outcome (both modes). */
  pipeline: Check[];
  /** Acceptance criteria and failure conditions checked on a real model's answer (live mode). */
  answer: Check[];
  /** Explicit failure conditions, in words, for reviewers. */
  failureConditions: string[];
  method: string;
  /** Deterministic-mode provider script. */
  script?: Script;
  /** Apply `answer` checks to the scripted answer too (cases that test verification logic). */
  answerChecksInDeterministic?: boolean;
  /** Cases that need a real model to say anything useful. Skipped in deterministic mode. */
  liveOnly?: boolean;
  /** Pipeline-only cases (provider failures, cancellation). Skipped in live mode. */
  deterministicOnly?: boolean;
  budget?: { maxOutputTokens?: number; maxLatencyMs?: number };
  /** Settings patch applied for this case only (e.g. personalization). */
  settings?: Record<string, unknown>;
}

export type CaseStatus = "not_run" | "running" | "passed" | "failed" | "skipped" | "inconclusive";

export interface CheckResult {
  scope: AssertionScope;
  metric: Metric;
  describe: string;
  passed: boolean;
  /** What was observed (bounded, no secrets). */
  detail: string;
}

export interface CaseResult {
  caseId: string;
  /** Hash of the case definition, so a comparison can tell when a case itself changed. */
  caseHash: string;
  category: EvalCategory;
  /** 1-based repeat index. */
  attempt: number;
  status: CaseStatus;
  reason?: string;
  checks: CheckResult[];
  outcome: "done" | "error" | "cancelled" | "timeout" | "not_run";
  errorCode?: string;
  model: string | null;
  /** Classified intent the pipeline chose. */
  intent?: { category: string; relation: string; ambiguous: boolean };
  /** Exactly what was sent: system blocks and the final user turn (text parts only). */
  input?: { system: string; user: string; historyMessages: number };
  output?: string;
  warnings: string[];
  verificationFlags: string[];
  latency: { ttftMs: number | null; totalMs: number };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
  retries: number;
}

export interface RunConfig {
  mode: "deterministic" | "live";
  provider: string;
  model: string;
  promptVersion: string;
  /** Short hash of the base system prompt actually used. */
  promptHash: string;
  contextBudgetChars: number;
  verification: boolean;
  repeat: number;
  concurrency: number;
  label?: string;
}

/** A pipeline variation evaluated against the same cases. */
export interface Variant {
  name: string;
  promptVersion?: string;
  contextBudgetChars?: number;
  verification?: boolean;
  /** Another model of the same, configured provider (live mode only). */
  model?: string;
}

export interface RunLimits {
  maxCases: number;
  concurrency: number;
  maxOutputTokens: number;
  /** Stop starting new cases once the estimated spend reaches this. */
  maxCostUsd: number;
  caseTimeoutMs: number;
}

export interface MetricSummary {
  passed: number;
  total: number;
}

export interface RunSummary {
  counts: Record<Exclude<CaseStatus, "running">, number>;
  byCategory: Record<string, { passed: number; failed: number; skipped: number; inconclusive: number }>;
  byMetric: Partial<Record<Metric, MetricSummary>>;
  latency: { p50TtftMs: number | null; p50TotalMs: number | null; p95TotalMs: number | null; n: number };
  usage: { inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean };
  /** Per-case pass rate across repeats (only when repeat > 1). */
  stability?: { caseId: string; passRate: number; runs: number }[];
}

export interface EvalRun {
  schemaVersion: number;
  id: string;
  createdAt: number;
  finishedAt: number | null;
  benchmarkVersion: string;
  /** complete = every selected case reached a final status; anything else is not a complete run. */
  status: "running" | "complete" | "partial" | "cancelled" | "failed";
  stopReason?: string;
  config: RunConfig;
  limits: RunLimits;
  caseIds: string[];
  results: CaseResult[];
  summary: RunSummary;
  metricDefinitions: Record<Metric, string>;
  limitations: string[];
  /** Hardware and runtime conditions, so local benchmarks can be interpreted and reproduced. */
  environment?: {
    os: string;
    cpu: string;
    cpuCount: number;
    memoryGb: number;
    location: "none" | "local" | "cloud";
    runtimeVersion?: string | null;
    /** Models the local runtime held in memory after the run (size = RAM/VRAM footprint). */
    loadedModels?: { name: string; sizeBytes: number; vramBytes: number }[];
  };
  /** Set when the run is one variant of an experiment. */
  experiment?: { id: string; name: string; variant: string };
}

export interface RunListItem {
  id: string;
  createdAt: number;
  status: EvalRun["status"];
  mode: RunConfig["mode"];
  model: string;
  label?: string;
  benchmarkVersion: string;
  counts: RunSummary["counts"];
  isBaseline: boolean;
}
