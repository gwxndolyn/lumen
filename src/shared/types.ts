// Shared contract between the Electron main process, preload bridge and renderer.
// Keep this file free of runtime imports so it can be used from every layer.

/** Session type: the persona / task the session is for. */
export type AssistantMode = "general" | "meeting" | "interview" | "technical" | "coding";
/** How a single answer should be shaped. */
export type AnswerStyle = "quick" | "detailed" | "steps" | "suggest" | "technical" | "meeting_summary" | "follow_ups";
export type Tone = "neutral" | "friendly" | "formal" | "confident";
export type ProviderKind = "anthropic" | "openai_compat" | "mock";
export type TranscriptionKind = "deepgram" | "none";
export type Effort = "low" | "medium" | "high";
export type ThemePref = "dark" | "light" | "system";
export type OverlayPosition = "custom" | "top-center" | "top-right" | "bottom-right" | "bottom-center";
export type LogLevel = "off" | "error" | "info" | "debug";
export type SecretName = "anthropic" | "deepgram" | "openai_compat";

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
    openaiCompat: { baseUrl: string; model: string };
    /** Daily estimated-spend cap in USD; 0 = no limit. */
    dailySpendLimitUsd: number;
  };
  transcription: {
    kind: TranscriptionKind;
    language: string;
    microphoneDeviceId: string | null;
    captureSystemAudio: boolean;
    /** When false, transcripts are kept in memory only and discarded when recording stops. */
    persist: boolean;
  };
  assistant: {
    mode: AssistantMode;
    style: AnswerStyle;
    tone: Tone;
    useKnowledgeBase: boolean;
    useConversationHistory: boolean;
  };
  screen: {
    /** Show a preview and require confirmation before a capture can be used. */
    requirePreview: boolean;
    /** Send the image itself to vision models (otherwise only OCR text is sent). */
    sendImages: boolean;
    ocr: boolean;
    liveIntervalSec: number;
  };
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

export type ContextSource =
  | "user_message"
  | "selected_text"
  | "clipboard"
  | "document"
  | "screenshot"
  | "ocr"
  | "transcript"
  | "note"
  | "history"
  | "knowledge";

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
}

export interface ChatSendRequest {
  requestId: string;
  sessionId: string;
  conversationId: string | null;
  text: string;
  style: AnswerStyle;
  tone: Tone;
  includeLiveTranscript: boolean;
  /** When set, re-generates the reply to the last user message instead of adding a new one. */
  retryOfMessageId?: string;
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
      warnings: string[];
      availability: SourceAvailability;
      contextPrepMs: number;
    }
  | { type: "delta"; requestId: string; text: string }
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
  attachments?: string[];
  style?: AnswerStyle;
  ttftMs?: number | null;
  totalMs?: number;
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

export type SecretsStatus = Record<SecretName, boolean> & { encryptionAvailable: boolean };

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
}

export interface RequestMetric {
  at: number;
  model: string;
  ttftMs: number | null;
  totalMs: number;
  contextPrepMs: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  outcome: "ok" | "error" | "cancelled";
  errorCode?: ErrorCode;
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
  shortcutsRegistered: Record<string, boolean>;
  metrics: {
    requests: RequestMetric[];
    p50TtftMs: number | null;
    p95TtftMs: number | null;
    p50TotalMs: number | null;
    p50ContextPrepMs: number | null;
    errorRate: number | null;
    totalRetries: number;
    failuresByCode: Record<string, number>;
    sessionCostUsd: number;
    transcriptionP50LatencyMs: number | null;
    ocrP50Ms: number | null;
  };
  process: { memoryMb: number; cpuPercent: number };
  storage: { sessions: number; conversations: number; messages: number; transcripts: number; knowledgeDocs: number; contextItems: number };
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export type WindowRole = "overlay" | "main";
