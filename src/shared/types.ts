// Shared contract between the Electron main process, preload bridge and renderer.
// Keep this file free of runtime imports so it can be used from every layer.

export type AssistantMode = "general" | "meeting" | "interview" | "technical" | "coding";
export type ResponseLength = "short" | "detailed";
export type Tone = "neutral" | "friendly" | "formal" | "confident";
export type ProviderKind = "anthropic" | "mock";
export type TranscriptionKind = "deepgram" | "none";
export type Effort = "low" | "medium" | "high";
export type ThemePref = "dark" | "light" | "system";

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
  provider: {
    kind: ProviderKind;
    model: string;
    effort: Effort;
    maxTokens: number;
    timeoutMs: number;
  };
  transcription: {
    kind: TranscriptionKind;
    language: string;
    microphoneDeviceId: string | null;
    captureSystemAudio: boolean;
  };
  assistant: {
    mode: AssistantMode;
    length: ResponseLength;
    tone: Tone;
    useKnowledgeBase: boolean;
    useConversationHistory: boolean;
  };
  overlay: {
    opacity: number;
    alwaysOnTop: boolean;
    bounds: OverlayBounds | null;
    followCursorDisplay: boolean;
  };
  shortcuts: {
    toggleOverlay: string;
    askAboutScreen: string;
    openMainWindow: string;
  };
  privacy: {
    /** 0 means "keep until I delete it" — an explicit user choice. */
    transcriptRetentionDays: number;
    conversationRetentionDays: number;
    keepScreenshotsInHistory: false;
  };
  /** App-level consent for each context source. OS permission is tracked separately. */
  consent: {
    screen: boolean;
    microphone: boolean;
    systemAudio: boolean;
  };
}

export type ContextKind = "note" | "clipboard" | "document" | "screenshot" | "transcript" | "knowledge" | "history";

export interface ContextItemSummary {
  id: string;
  kind: ContextKind;
  title: string;
  chars: number;
  createdAt: number;
  pinned: boolean;
  enabled: boolean;
  hasImage: boolean;
  /** Heuristic prompt-injection flag — shown to the user, content is still treated as data. */
  suspicious: boolean;
  preview: string;
}

export interface ContextReference {
  label: string; // e.g. "C1"
  kind: ContextKind;
  title: string;
  excerpt: string;
}

export interface ChatSendRequest {
  requestId: string;
  conversationId: string | null;
  text: string;
  mode: AssistantMode;
  length: ResponseLength;
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
      conversationId: string;
      userMessageId: string;
      references: ContextReference[];
      provider: { kind: ProviderKind; model: string; isMock: boolean };
      warnings: string[];
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
    }
  | { type: "error"; requestId: string; message: string; code: ErrorCode; retryable: boolean }
  | { type: "cancelled"; requestId: string; partialMessageId: string | null };

export type ErrorCode =
  | "missing_credentials"
  | "auth"
  | "rate_limited"
  | "overloaded"
  | "network"
  | "timeout"
  | "refusal"
  | "bad_request"
  | "context_too_large"
  | "unknown";

export interface Conversation {
  id: string;
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
  parentId: string; // conversation id or transcript session id
  parentTitle: string;
  itemId: string;
  snippet: string;
  createdAt: number;
}

export interface TranscriptSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  segmentCount: number;
  provider: string;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  edited: boolean;
}

export type TranscriptStatus = "idle" | "connecting" | "recording" | "paused" | "reconnecting" | "stopped" | "error";

export type TranscriptEvent =
  | { type: "status"; sessionId: string | null; status: TranscriptStatus; detail?: string }
  | { type: "interim"; sessionId: string; text: string; speaker: string | null }
  | { type: "segment"; segment: TranscriptSegment; latencyMs: number | null };

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
  chars: number;
  chunkCount: number;
  createdAt: number;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  displayId: string | null;
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

export interface SecretsStatus {
  anthropic: boolean;
  deepgram: boolean;
  encryptionAvailable: boolean;
}

export interface RequestMetric {
  at: number;
  model: string;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  outcome: "ok" | "error" | "cancelled";
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
  provider: { kind: ProviderKind; model: string; configured: boolean };
  transcription: { kind: TranscriptionKind; configured: boolean };
  permissions: PermissionStatus;
  shortcutsRegistered: Record<string, boolean>;
  metrics: {
    requests: RequestMetric[];
    p50TtftMs: number | null;
    p95TtftMs: number | null;
    p50TotalMs: number | null;
    errorRate: number | null;
    sessionCostUsd: number;
    transcriptionP50LatencyMs: number | null;
  };
  process: { memoryMb: number; cpuPercent: number };
  storage: { conversations: number; messages: number; transcripts: number; knowledgeDocs: number };
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export type WindowRole = "overlay" | "main";
