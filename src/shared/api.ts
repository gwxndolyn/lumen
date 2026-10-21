import type {
  AssistantMode,
  CaptureCapabilities,
  CaptureRegion,
  CaptureSource,
  ChatEvent,
  ChatMessage,
  ChatSendRequest,
  ContextItemSummary,
  ContextPermission,
  Conversation,
  Diagnostics,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeImportResult,
  LiveScreenState,
  MeetingInsights,
  PermissionStatus,
  ProviderHealth,
  ProviderTestResult,
  SearchHit,
  SecretName,
  SecretsStatus,
  Session,
  SessionAiConfig,
  SessionSummary,
  Settings,
  TranscriptEvent,
  TranscriptSegment,
  TranscriptSession,
  TranscriptStatus,
  WindowRole,
} from "./types";

export type AppEvent =
  | { type: "settings"; settings: Settings }
  | { type: "context"; sessionId: string; items: ContextItemSummary[] }
  | { type: "navigate"; to: string }
  | { type: "focus-input" }
  | { type: "history-changed" }
  | { type: "sessions-changed" }
  | { type: "session-switched"; sessionId: string }
  | { type: "permission-revoked"; permission: ContextPermission }
  | { type: "provider-health"; health: ProviderHealth }
  | { type: "live-screen"; state: LiveScreenState }
  | { type: "overlay-mode"; mode: "compact" | "expanded" }
  | { type: "audio-command"; command: "start" | "stop" | "system-off"; micDeviceId: string | null; systemAudio: boolean }
  | { type: "toast"; level: "info" | "error"; message: string };

export interface CapturePreview {
  captureId: string;
  previewDataUrl: string;
  width: number;
  height: number;
  title: string;
}

export interface TranscriptState {
  sessionId: string | null;
  workspaceSessionId: string | null;
  status: TranscriptStatus;
  title: string | null;
  persisted: boolean;
  channels: 1 | 2;
  segments: TranscriptSegment[];
}

/** The API exposed to renderers as `window.lumen` by the preload script. */
export interface LumenApi {
  role: WindowRole;
  platform: string;

  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  resetShortcuts(): Promise<Settings>;
  getShortcutStatus(): Promise<Record<string, boolean>>;

  secretsStatus(): Promise<SecretsStatus>;
  setSecret(name: SecretName, value: string): Promise<SecretsStatus>;
  clearSecret(name: SecretName): Promise<SecretsStatus>;
  testProvider(): Promise<ProviderTestResult>;
  providerHealth(): Promise<ProviderHealth>;

  listSessions(): Promise<SessionSummary[]>;
  activeSession(): Promise<Session>;
  createSession(input: { title: string; type: AssistantMode; notes?: string; contextTtlMinutes?: number | null; ai?: SessionAiConfig }): Promise<Session>;
  updateSession(id: string, patch: Partial<Pick<Session, "title" | "type" | "notes" | "contextTtlMinutes" | "ai">>): Promise<Session>;
  switchSession(id: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  exportSession(id: string): Promise<string | null>;

  chatSend(req: Omit<ChatSendRequest, "sessionId"> & { sessionId?: string }): Promise<void>;
  chatCancel(requestId: string): Promise<boolean>;
  listConversations(sessionId?: string): Promise<Conversation[]>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  search(query: string, scope: "session" | "all"): Promise<SearchHit[]>;

  listContext(): Promise<ContextItemSummary[]>;
  addNote(title: string, text: string): Promise<ContextItemSummary[]>;
  addClipboard(): Promise<ContextItemSummary[]>;
  addSelection(): Promise<ContextItemSummary[]>;
  addDocuments(): Promise<{ items: ContextItemSummary[]; failed: { file: string; reason: string }[] }>;
  updateContext(id: string, patch: { enabled?: boolean; pinned?: boolean }): Promise<ContextItemSummary[]>;
  confirmContext(id: string): Promise<ContextItemSummary[]>;
  removeContext(id: string): Promise<ContextItemSummary[]>;
  clearContext(source?: "screen" | "notes" | "documents"): Promise<ContextItemSummary[]>;

  captureCapabilities(): Promise<CaptureCapabilities>;
  listCaptureSources(): Promise<CaptureSource[]>;
  captureSource(sourceId: string): Promise<CapturePreview>;
  importImage(): Promise<CapturePreview | null>;
  attachCapture(captureId: string, region: CaptureRegion | null, title: string): Promise<ContextItemSummary[]>;
  discardCapture(captureId: string): Promise<void>;
  quickCapture(): Promise<ContextItemSummary[]>;
  liveScreen(action: "start" | "pause" | "resume" | "stop"): Promise<LiveScreenState>;
  liveScreenState(): Promise<LiveScreenState>;

  listKnowledge(): Promise<KnowledgeDoc[]>;
  importKnowledge(kind: "files" | "folder", scope: "global" | "session"): Promise<KnowledgeImportResult & { docs: KnowledgeDoc[] }>;
  addKnowledgeText(title: string, text: string, scope: "global" | "session"): Promise<KnowledgeDoc[]>;
  deleteKnowledge(id: string): Promise<KnowledgeDoc[]>;
  searchKnowledge(query: string): Promise<KnowledgeHit[]>;

  transcriptStart(title: string): Promise<void>;
  transcriptPause(): Promise<void>;
  transcriptResume(): Promise<void>;
  transcriptStop(): Promise<void>;
  transcriptAudio(pcm: Uint8Array): void;
  transcriptAudioState(state: { micLabel: string | null; systemAudio: "off" | "active" | "unavailable" | "denied"; micLevel: number; systemLevel: number; silentForMs: number }): void;
  transcriptCaptureFailed(message: string, kind: "microphone" | "system"): void;
  transcriptState(): Promise<TranscriptState>;
  listTranscripts(): Promise<TranscriptSession[]>;
  getSegments(transcriptId: string): Promise<TranscriptSegment[]>;
  updateSegment(id: string, text: string, speaker: string | null): Promise<void>;
  deleteSegment(id: string): Promise<void>;
  renameTranscript(id: string, title: string): Promise<void>;
  deleteTranscript(id: string): Promise<void>;
  generateInsights(transcriptId: string): Promise<MeetingInsights>;
  getInsights(transcriptId: string): Promise<MeetingInsights | null>;

  permissions(): Promise<PermissionStatus>;
  requestMicrophone(): Promise<PermissionStatus>;
  openPermissionSettings(kind: "screen" | "microphone"): Promise<void>;

  exportData(): Promise<string | null>;
  deleteAllData(): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
  openLogs(): Promise<void>;

  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  overlay(action: "hide" | "toggle" | "expand" | "compact" | "reset-position"): Promise<void>;
  openMain(route?: string): Promise<void>;
  setOverlaySize(width: number, height: number): Promise<void>;

  onChat(fn: (e: ChatEvent) => void): () => void;
  onTranscript(fn: (e: TranscriptEvent) => void): () => void;
  onApp(fn: (e: AppEvent) => void): () => void;
}
