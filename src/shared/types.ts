// Shared contract between the Electron main process, preload bridge and renderer.
// Keep this file free of runtime imports so it can be used from every layer.

/** Session type: the persona / task the session is for. */
export type AssistantMode = "general" | "meeting" | "interview" | "technical" | "coding";
/** How a single answer should be shaped. */
export type AnswerStyle = "quick" | "detailed" | "steps" | "suggest" | "technical" | "meeting_summary" | "follow_ups";
export type Tone = "neutral" | "friendly" | "formal" | "confident";
export type ProviderKind = "anthropic" | "openai" | "gemini" | "openai_compat" | "ollama" | "mock";
export type TranscriptionKind = "deepgram" | "none";
export type Effort = "low" | "medium" | "high";
export type ThemePref = "dark" | "light" | "system";
export type OverlayPosition = "custom" | "top-center" | "top-right" | "bottom-right" | "bottom-center";
export type LogLevel = "off" | "error" | "info" | "debug";
export type SecretName = "anthropic" | "openai" | "gemini" | "deepgram" | "openai_compat";

export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId: number | null;
}

export interface Settings {
  version: 1;
  onboardingComplete: boolean;
  /** Last onboarding step reached, so a restart resumes there. */
  onboardingStep: number;
  theme: ThemePref;
  activeSessionId: string | null;
  provider: {
    kind: ProviderKind;
    model: string;
    effort: Effort;
    maxTokens: number;
    timeoutMs: number;
    /** Abort a stream that produces no events for this long. */
    idleTimeoutMs: number;
    openaiCompat: { baseUrl: string; model: string; supportsImages: boolean };
    openai: { model: string };
    gemini: { model: string };
    /** Daily estimated-spend cap in USD; 0 = no limit. */
    dailySpendLimitUsd: number;
    /** "economy" may use a cheaper model of the SAME provider for quick, light questions. */
    routing: "off" | "economy";
    /** User-entered price (USD per million tokens) for models without bundled pricing. */
    customPrice: { input: number; output: number } | null;
  };
  transcription: {
    kind: TranscriptionKind;
    language: string;
    microphoneDeviceId: string | null;
    captureSystemAudio: boolean;
    /** When false, transcripts are kept in memory only and discarded when recording stops. */
    persist: boolean;
    /** Technical terms to boost in recognition (Deepgram keyterm prompting). */
    vocabulary: string[];
  };
  assistant: {
    mode: AssistantMode;
    style: AnswerStyle;
    tone: Tone;
    useKnowledgeBase: boolean;
    useConversationHistory: boolean;
    /** Send relevant user-saved project memory with questions. */
    useProjectMemory: boolean;
  };
  /** How Lumen reacts to questions detected in the live transcript. */
  questions: {
    /**
     * manual: Lumen only answers what the user submits.
     * assisted: in interview-practice sessions, a detected question gets a suggested answer.
     */
    policy: "manual" | "assisted";
  };
  /** Applied to every answer through the response orchestrator (stated once in the system prompt). */
  personalization: {
    depth: "quick" | "balanced" | "deep";
    alsoKnows: ("python" | "java" | "javascript" | "typescript" | "cpp" | "sql" | "go" | "csharp" | "kotlin" | "rust")[];
    codeStyle: "idiomatic" | "commented" | "compact";
    hintsFirst: boolean;
    includeComplexity: boolean;
    includeTests: boolean;
  };
  interview: {
    length: "short" | "medium" | "detailed";
    /** Whose speech counts as the interviewer: system-audio channel, or anyone except "You". */
    interviewer: "remote" | "any";
  };
  technical: {
    language: "python" | "java" | "javascript" | "typescript" | "cpp" | "sql" | "go" | "csharp" | "kotlin" | "rust";
    /** Pitch of explanations. */
    level: "junior" | "mid" | "senior";
    /** "concise" gives the shortest useful answer; the user can ask for the full breakdown. */
    detail: "concise" | "full";
  };
  screen: {
    /** Show a preview and require confirmation before a capture can be used. */
    requirePreview: boolean;
    /** Send the image itself to vision models (otherwise only OCR text is sent). */
    sendImages: boolean;
    ocr: boolean;
    liveIntervalSec: number;
  };
  /** Main window geometry, restored on next open (null = centred default). */
  mainWindow: { bounds: OverlayBounds | null; maximized: boolean };
  overlay: {
    opacity: number;
    alwaysOnTop: boolean;
    bounds: OverlayBounds | null;
    followCursorDisplay: boolean;
    position: OverlayPosition;
    expandedHeight: number;
  };
  /** Global shortcuts (Electron accelerators). Empty string = disabled. */
  shortcuts: {
    requestAssist: string;
    toggleOverlay: string;
    scrollUp: string;
    scrollDown: string;
    moveLeft: string;
    moveRight: string;
    discreetInput: string;
    askAboutScreen: string;
    askAboutSelection: string;
    openMainWindow: string;
    cancelResponse: string;
    toggleAudio: string;
  };

  privacy: {
    /** 0 means "keep until I delete it" — an explicit user choice. */
    transcriptRetentionDays: number;
    conversationRetentionDays: number;
    keepScreenshotsInHistory: false;
    /** Mask detected secrets (card numbers, API keys, passwords) before sending to a provider. */
    redactSensitive: boolean;
    /** Default lifetime of screen-derived context, in minutes. */
    screenContextTtlMinutes: number;
  };
  /** App-level consent for each context source. OS permission is tracked separately. */
  consent: {
    screen: boolean;
    microphone: boolean;
    systemAudio: boolean;
  };
  diagnostics: {
    logLevel: LogLevel;
    /**
     * Record content-free usage events (request outcomes, timings, setup milestones) on this
     * computer for the Quality screen and, only if the user ticks it, a beta report. Nothing is
     * transmitted. Off = nothing new is recorded.
     */
    recordUsageEvents: boolean;
  };
  /** Hybrid local/cloud inference. The cloud side is `provider`; the local side is an Ollama runtime. */
  inference: {
    /**
     * manual: always use `provider.kind` (which may itself be "ollama").
     * local_first: use the local model when it is suitable, otherwise the cloud provider.
     * cloud_first: use the cloud provider, unless privacy or availability rules out the request.
     */
    mode: "manual" | "local_first" | "cloud_first";
    local: {
      /** Loopback URL of the Ollama runtime. */
      baseUrl: string;
      /** Installed model to use ("" = none chosen). */
      model: string;
      /** Context window requested from the runtime (tokens). Larger needs more memory. */
      numCtx: number;
      /** Local embedding model for semantic knowledge search ("" = keyword search only). */
      embeddingModel: string;
    };
    /** When true, protected context is only sent to a cloud provider for the kinds allowed below. */
    privacyRestricted: boolean;
    cloudAllowed: { screen: boolean; transcript: boolean; documents: boolean };
    fallback: {
      /** Retry on the local model when the cloud provider fails (data stays on this device). */
      cloudToLocal: boolean;
      /** Retry on the cloud provider when the local model fails. Off by default: it sends data off-device. */
      localToCloud: boolean;
    };
    /** Reuse an identical answer (same model, prompt and context) for 10 minutes. Kept in memory only. */
    responseCache: boolean;
  };
  limits: {
    /** 0 = no limit. */
    requestsPerSession: number;
    /** Estimated USD per workspace session; 0 = no limit. */
    costPerSessionUsd: number;
    /** Warn when an estimated budget reaches this share. */
    warnAtPercent: number;
    maxConcurrentRequests: number;
    /** Characters of context sent with one question. */
    maxContextChars: number;
    /** Attempts per request including the first. */
    maxAttempts: number;
    /** Retry after a timeout (the first attempt may still have been processed and billed). */
    retryTimeouts: boolean;
  };
}

// ---------------- sessions ----------------

export interface SessionAiConfig {
  model?: string;
  effort?: Effort;
  style?: AnswerStyle;
}

export interface Session {
  id: string;
  title: string;
  type: AssistantMode;
  notes: string;
  createdAt: number;
  updatedAt: number;
  /** null = app default; 0 = keep until the session is deleted. */
  contextTtlMinutes: number | null;
  ai: SessionAiConfig;
}

export interface SessionSummary extends Session {
  conversations: number;
  transcripts: number;
  contextItems: number;
  documents: number;
}

// ---------------- context ----------------

export type ContextSource = "user_message" | "selected_text" | "clipboard" | "document" | "screenshot" | "ocr" | "transcript" | "note" | "history" | "knowledge" | "memory";

/** Which consent gates a record. "user" = explicitly provided by the user, no OS permission. */
export type ContextPermission = "user" | "screen" | "microphone" | "systemAudio";
export type Sensitivity = "normal" | "sensitive";

export interface ContextItemSummary {
  id: string;
  sessionId: string;
  source: ContextSource;
  sourceId: string;
  title: string;
  chars: number;
  createdAt: number;
  expiresAt: number | null;
  pinned: boolean;
  enabled: boolean;
  /** pending = awaiting user confirmation (previews); active = usable as context. */
  status: "pending" | "active";
  hasImage: boolean;
  thumbnailDataUrl: string | null;
  ocr: "none" | "running" | "done" | "failed";
  confidence: number | null;
  sensitivity: Sensitivity;
  sensitiveKinds: string[];
  permission: ContextPermission;
  /** Heuristic prompt-injection flag — shown to the user, content is still treated as data. */
  suspicious: boolean;
  warning: string | null;
  preview: string;
}

export interface ContextReference {
  label: string; // e.g. "C1"
  kind: ContextSource;
  title: string;
  excerpt: string;
  sourceId?: string;
  /** Why this source was included (for the context inspector). */
  why?: "pinned" | "attached" | "matched" | "recent";
  score?: number;
}

/** Context-selection summary for one request (no content, only counts and reasons). */
export interface ContextSelection {
  considered: number;
  included: number;
  droppedForBudget: number;
  belowRelevance: number;
  contextChars: number;
  budgetChars: number;
}

export interface ChatSendRequest {
  requestId: string;
  /** Mode-specific instruction appended to the system policy (built by core/workflows.ts). */
  taskInstruction?: string;
  /** Text stored as the user's message when it differs from the prompt (e.g. a detected question). */
  displayText?: string;
  /** What to search/rank context with when the prompt contains instructions (defaults to the text). */
  retrievalQuery?: string;
  /** Short label for the UI (e.g. "Behavioral question"). */
  origin?: { kind: "interview" | "technical" | "notes"; label: string; questionId?: string };
  sessionId: string;
  conversationId: string | null;
  text: string;
  style: AnswerStyle;
  tone: Tone;
  includeLiveTranscript: boolean;
  /** When set, re-generates the reply to the last user message instead of adding a new one. */
  retryOfMessageId?: string;
  /** Overrides the preferred answer depth for this request. */
  depth?: "quick" | "balanced" | "deep";
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

export type ChatEvent =
  | {
      type: "start";
      requestId: string;
      sessionId: string;
      conversationId: string;
      userMessageId: string;
      references: ContextReference[];
      provider: { kind: ProviderKind; model: string; isMock: boolean };
      /** Hybrid routing decision, when hybrid routing is on. */
      routing?: { route: "local" | "cloud"; reason: string; leavesDevice: boolean };
      warnings: string[];
      availability: SourceAvailability;
      contextPrepMs: number;
      intent: ResponseIntent;
      selection: ContextSelection;
    }
  | { type: "delta"; requestId: string; text: string }
  | { type: "suggestion"; requestId: string; question: { id: string; text: string; category: string; categoryLabel: string; startMs: number } }
  | { type: "retrying"; requestId: string; attempt: number; delayMs: number; reason: string }
  | {
      type: "done";
      requestId: string;
      messageId: string;
      usage: UsageInfo;
      ttftMs: number | null;
      totalMs: number;
      stopReason: string;
      servedByFallback: string | null;
      citedLabels: string[];
      verification: AnswerVerification;
      routedFrom?: string;
      /** Served from the in-memory response cache (no provider call). */
      cached?: boolean;
    }
  | { type: "error"; requestId: string; message: string; code: ErrorCode; retryable: boolean; conversationId: string | null }
  | { type: "cancelled"; requestId: string; partialMessageId: string | null };

/** What context exists for a request — shown to the user and told to the model. */
export interface SourceAvailability {
  transcript: "live" | "none";
  screen: number;
  documents: number;
  notes: number;
  knowledge: number;
  history: number;
  memory?: number;
}

export type ErrorCode =
  | "missing_credentials"
  | "auth"
  | "rate_limited"
  | "overloaded"
  | "network"
  | "timeout"
  | "refusal"
  | "bad_request"
  | "busy"
  | "storage"
  | "empty_response"
  | "spend_limit"
  | "context_too_large"
  /** Hybrid routing found no target allowed by the user's privacy and availability settings. */
  | "routing_blocked"
  | "unknown";

export interface Conversation {
  id: string;
  sessionId: string;
  title: string;
  mode: AssistantMode;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface MessageMeta {
  model?: string;
  isMock?: boolean;
  estimatedCostUsd?: number;
  stopReason?: string;
  cancelled?: boolean;
  /** The stream failed after some text arrived; the partial text was kept. Excluded from history. */
  interrupted?: boolean;
  attachments?: string[];
  style?: AnswerStyle;
  origin?: { kind: "interview" | "technical" | "notes"; label: string; questionId?: string };
  ttftMs?: number | null;
  totalMs?: number;
  /** How the response orchestrator understood this turn (deterministic, not a model judgement). */
  intent?: ResponseIntent;
  /** Deterministic post-generation checks (see core/intelligence/verify.ts). */
  verification?: AnswerVerification;
  /** Set when economy routing chose a different model of the same provider. */
  routedFrom?: string;
  /** Provider kind that produced the answer. */
  provider?: ProviderKind;
  /** Where hybrid routing ran it. */
  route?: "local" | "cloud";
  cached?: boolean;
  /** A policy-approved fallback served this answer after the first target failed. */
  fellBack?: boolean;
}

export interface ResponseIntent {
  relation: "new" | "follow_up" | "elaborate" | "simplify" | "correction" | "screen" | "revise_code";
  category: string;
  depth: "quick" | "balanced" | "deep";
  label: string;
  ambiguous?: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  references: ContextReference[];
  meta: MessageMeta;
}

export interface SearchHit {
  kind: "message" | "transcript";
  sessionId: string;
  parentId: string; // conversation id or transcript id
  parentTitle: string;
  itemId: string;
  snippet: string;
  createdAt: number;
}

export interface TranscriptSession {
  id: string;
  sessionId: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  segmentCount: number;
  provider: string;
  persisted: boolean;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string; // transcript id
  startMs: number;
  endMs: number;
  speaker: string | null;
  channel: "mic" | "system" | null;
  text: string;
  edited: boolean;
  confidence: number | null;
}

export type TranscriptStatus = "idle" | "connecting" | "recording" | "paused" | "reconnecting" | "stopped" | "error";

export interface AudioInputState {
  micLabel: string | null;
  systemAudio: "off" | "active" | "unavailable" | "denied";
  micLevel: number;
  systemLevel: number;
  silentForMs: number;
}

export type TranscriptEvent =
  | {
      type: "status";
      sessionId: string | null;
      workspaceSessionId: string | null;
      status: TranscriptStatus;
      detail?: string;
      action?: "retry" | "settings" | "microphone" | "permissions";
    }
  | { type: "interim"; sessionId: string; text: string; speaker: string | null; channel: "mic" | "system" | null }
  | { type: "segment"; segment: TranscriptSegment; latencyMs: number | null }
  | { type: "audio"; state: AudioInputState };

export interface MeetingInsights {
  sessionId: string;
  generatedAt: number;
  model: string;
  isMock: boolean;
  summary: string;
  keyPoints: string[];
  actionItems: { task: string; owner: string | null }[];
  questionsToAsk: string[];
  suggestedResponses: string[];
  followUpEmail: { subject: string; body: string };
  /** Notetaker sections (v0.3). Older stored notes may lack them. */
  discussionPoints?: string[];
  questionsAsked?: { question: string; askedBy: string | null; answerSummary: string | null }[];
  topics?: string[];
  decisions?: string[];
  unansweredQuestions?: string[];
  followUpPrep?: string[];
  conceptsToRevisit?: string[];
  /** True once the user has edited the notes; regeneration asks before overwriting. */
  edited?: boolean;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;
  /** null = global library, otherwise the session it is attached to. */
  sessionId: string | null;
  format: string;
  chars: number;
  chunkCount: number;
  createdAt: number;
}

export interface KnowledgeImportResult {
  imported: KnowledgeDoc[];
  failed: { file: string; reason: string }[];
  skipped: number;
}

export interface KnowledgeHit {
  docId: string;
  title: string;
  chunkId: string;
  snippet: string;
  text: string;
  sessionId: string | null;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  displayId: string | null;
}

export interface CaptureCapabilities {
  platform: string;
  screens: boolean;
  windows: boolean;
  region: boolean;
  imageImport: boolean;
  liveScreen: boolean;
  ocr: boolean;
  permission: OsPermission;
  notes: string[];
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OsPermission = "granted" | "denied" | "restricted" | "not-determined" | "unknown" | "not-required";

export interface PermissionStatus {
  screen: OsPermission;
  microphone: OsPermission;
  systemAudioSupported: boolean;
  platform: string;
}

export type SecretsStatus = Record<SecretName, boolean> & { encryptionAvailable: boolean; unreadable: SecretName[] };

export interface ProviderHealth {
  kind: ProviderKind;
  model: string;
  state: "ok" | "degraded" | "down" | "unconfigured" | "mock" | "unknown";
  message: string;
  checkedAt: number | null;
  latencyMs: number | null;
}

export interface LiveScreenState {
  active: boolean;
  paused: boolean;
  intervalSec: number;
  lastCaptureAt: number | null;
  lastError: string | null;
  captures: number;
  /** Frames skipped because the screen had not changed since the last accepted frame. */
  skipped: number;
  /** inactive · active · paused · recovering (transient failure, retrying with backoff) ·
   *  permission_required · unsupported · failed (gave up after repeated failures). */
  status: "inactive" | "active" | "paused" | "recovering" | "permission_required" | "unsupported" | "failed";
  /** Consecutive failed captures. */
  failures: number;
  /** Current sampling interval after adaptive backoff (≥ intervalSec). */
  effectiveIntervalSec: number;
  /** Captures that finished after Stop or a session switch and were thrown away. */
  discarded: number;
  /** Display of the latest capture, when known. */
  display?: string | null;
}

/**
 * Deterministic post-generation checks. `code` lists each code block's syntax check with its real
 * status — "unavailable" and "skipped" are never shown as passing, and nothing is ever executed.
 */
export interface AnswerVerification {
  checksRun: number;
  findings: { check: string; severity: "warn" | "info"; message: string }[];
  code?: { block: number; lang: string; status: "passed" | "failed" | "unavailable" | "skipped"; method: string; detail: string | null }[];
}

/** Durations of the response pipeline stages for one request (ms), for diagnostics. No content. */
export interface StageTimings {
  plan: number;
  retrieve: number;
  rank: number;
  build: number;
  generate: number;
  verify: number;
}

export interface RequestMetric {
  at: number;
  model: string;
  ttftMs: number | null;
  totalMs: number;
  contextPrepMs: number;
  /** Time spent waiting for in-progress OCR before the request could be built. */
  pendingWaitMs?: number;
  /** Input received → provider request sent (everything Lumen does locally). */
  requestSentMs?: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  outcome: "ok" | "error" | "cancelled";
  errorCode?: ErrorCode;
  /** Present for requests that reached generation. */
  stages?: StageTimings;
  /** Task category the planner chose (no content). */
  category?: string;
}

export interface Diagnostics {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  userDataPath: string;
  dbPath: string;
  logPath: string;
  logLevel: LogLevel;
  provider: ProviderHealth;
  transcription: { kind: TranscriptionKind; configured: boolean };
  permissions: PermissionStatus;
  capture: CaptureCapabilities;
  platformProfile: import("../core/platform").PlatformProfile;
  shortcutsRegistered: Record<string, boolean>;
  /** Capture/processing pipeline state (counts and statuses only). */
  pipeline?: ReturnType<import("../core/app").AppCore["pipelineState"]>;
  metrics: {
    requests: RequestMetric[];
    p50TtftMs: number | null;
    p95TtftMs: number | null;
    p50TotalMs: number | null;
    p50ContextPrepMs: number | null;
    p50RequestSentMs: number | null;
    verification: { answers: number; checks: number; flagged: number; byCheck: Record<string, number> };
    p50PendingWaitMs: number | null;
    errorRate: number | null;
    totalRetries: number;
    failuresByCode: Record<string, number>;
    sessionCostUsd: number;
    transcriptionP50LatencyMs: number | null;
    ocrP50Ms: number | null;
    /** OCR jobs skipped because the frame was superseded first. */
    ocrCancelled: number;
    captureP50Ms: number | null;
    cancelP50Ms: number | null;
    cancelMaxMs: number | null;
    stagesP50?: Record<keyof StageTimings, number | null> | null;
  };
  process: { memoryMb: number; cpuPercent: number };
  storage: { sessions: number; conversations: number; messages: number; transcripts: number; knowledgeDocs: number; contextItems: number };
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  /** Why the test failed — lets the UI distinguish a bad key from a network problem or an outage. */
  code?: ErrorCode | "model_unavailable";
}

export type WindowRole = "overlay" | "main";
