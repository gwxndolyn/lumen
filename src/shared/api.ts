import type {
  CaptureRegion,
  CaptureSource,
  ChatEvent,
  ChatMessage,
  ChatSendRequest,
  ContextItemSummary,
  Conversation,
  Diagnostics,
  KnowledgeDoc,
  MeetingInsights,
  PermissionStatus,
  ProviderTestResult,
  SearchHit,
  SecretsStatus,
  Settings,
  TranscriptEvent,
  TranscriptSegment,
  TranscriptSession,
  WindowRole,
} from "./types";

export type AppEvent =
  | { type: "settings"; settings: Settings }
  | { type: "context"; items: ContextItemSummary[] }
  | { type: "navigate"; to: string }
  | { type: "focus-input" }
  | { type: "history-changed" }
  | { type: "audio-command"; command: "start" | "stop"; micDeviceId: string | null; systemAudio: boolean }
  | { type: "toast"; level: "info" | "error"; message: string };

/** The API exposed to renderers as `window.lumen` by the preload script. */
export interface LumenApi {
  role: WindowRole;
  platform: string;

  getSettings(): Promise<Settings>;
  updateSettings(patch: unknown): Promise<Settings>;
  resetShortcuts(): Promise<Settings>;
  getShortcutStatus(): Promise<Record<string, boolean>>;

  secretsStatus(): Promise<SecretsStatus>;
  setSecret(name: "anthropic" | "deepgram", value: string): Promise<SecretsStatus>;
  clearSecret(name: "anthropic" | "deepgram"): Promise<SecretsStatus>;
  testProvider(): Promise<ProviderTestResult>;

  chatSend(req: ChatSendRequest): Promise<void>;
  chatCancel(requestId: string): Promise<boolean>;
  listConversations(): Promise<Conversation[]>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  search(query: string): Promise<SearchHit[]>;

  listContext(): Promise<ContextItemSummary[]>;
  addNote(title: string, text: string): Promise<ContextItemSummary[]>;
  addClipboard(): Promise<ContextItemSummary[]>;
  addDocuments(): Promise<ContextItemSummary[]>;
  updateContext(id: string, patch: { enabled?: boolean; pinned?: boolean }): Promise<ContextItemSummary[]>;
  removeContext(id: string): Promise<ContextItemSummary[]>;
  clearContext(kind?: string): Promise<ContextItemSummary[]>;

  listCaptureSources(): Promise<CaptureSource[]>;
  captureSource(sourceId: string): Promise<{ captureId: string; previewDataUrl: string; width: number; height: number }>;
  attachCapture(captureId: string, region: CaptureRegion | null, title: string): Promise<ContextItemSummary[]>;
  discardCapture(captureId: string): Promise<void>;
  quickCapture(): Promise<ContextItemSummary[]>;

  listKnowledge(): Promise<KnowledgeDoc[]>;
  importKnowledge(): Promise<KnowledgeDoc[]>;
  addKnowledgeText(title: string, text: string): Promise<KnowledgeDoc[]>;
  deleteKnowledge(id: string): Promise<KnowledgeDoc[]>;

  transcriptStart(title: string): Promise<void>;
  transcriptPause(): Promise<void>;
  transcriptResume(): Promise<void>;
  transcriptStop(): Promise<void>;
  transcriptAudio(pcm: Uint8Array): void;
  transcriptCaptureFailed(message: string): void;
  transcriptState(): Promise<{ sessionId: string | null; status: string; title: string | null }>;
  listTranscripts(): Promise<TranscriptSession[]>;
  getSegments(sessionId: string): Promise<TranscriptSegment[]>;
  updateSegment(id: string, text: string, speaker: string | null): Promise<void>;
  deleteSegment(id: string): Promise<void>;
  renameTranscript(id: string, title: string): Promise<void>;
  deleteTranscript(id: string): Promise<void>;
  generateInsights(sessionId: string): Promise<MeetingInsights>;
  getInsights(sessionId: string): Promise<MeetingInsights | null>;

  permissions(): Promise<PermissionStatus>;
  requestMicrophone(): Promise<PermissionStatus>;
  openPermissionSettings(kind: "screen" | "microphone"): Promise<void>;

  exportData(): Promise<string | null>;
  deleteAllData(): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
  openLogs(): Promise<void>;

  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  overlay(action: "hide" | "toggle" | "expand" | "compact"): Promise<void>;
  openMain(route?: string): Promise<void>;
  setOverlaySize(width: number, height: number): Promise<void>;

  onChat(fn: (e: ChatEvent) => void): () => void;
  onTranscript(fn: (e: TranscriptEvent) => void): () => void;
  onApp(fn: (e: AppEvent) => void): () => void;
}
