import type { AppEvent } from "../shared/api";
import { activeModel, DEFAULT_SHORTCUTS, PROVIDER_INFO } from "../shared/defaults";
import { applySettingsPatch } from "../shared/settingsSchema";
import type {
  AnswerStyle,
  AssistantMode,
  ChatEvent,
  ChatSendRequest,
  ContextPermission,
  KnowledgeImportResult,
  LiveScreenState,
  MeetingInsights,
  ProviderHealth,
  ProviderTestResult,
  SecretName,
  Session,
  SessionAiConfig,
  Settings,
  Tone,
  TranscriptEvent,
  TranscriptSegment,
} from "../shared/types";
import { ChatService, type LiveTranscriptContext } from "./chatService";
import { ContextEngine, type ContextRecord } from "./context/engine";
import { addKnowledgeText, importKnowledge } from "./knowledge";
import { LiveScreen } from "./liveScreen";
import { hasChanged } from "./frameDiff";
import { generateInsights, notesToMarkdown } from "./meetingService";
import { CATEGORY_LABELS, classifyQuestion, QuestionDetector, type DetectedQuestion, type QuestionCategory } from "./interview/questions";
import { parseProblem, problemToContext, type Language, type ParsedProblem } from "./technical/problem";
import { interviewPrompt, technicalPrompt, type AnswerLength, type TechnicalDetail, type TechnicalTask } from "./workflows";
import { chunkText, normalizeText } from "./context/text";
import { PROFILE_SECTIONS, type ProfileSection } from "./interview/profile";
import { Metrics } from "./metrics";
import type { OcrEngine } from "./ocr";
import { AnthropicProvider } from "./providers/anthropic";
import { MockProvider } from "./providers/mock";
import { OpenAICompatProvider } from "./providers/openaiCompat";
import { GeminiProvider } from "./providers/gemini";
import { ProviderError, type AIProvider } from "./providers/types";
import { toUserError } from "./errors";
import type { Store } from "./storage/db";
import { DeepgramProvider } from "./transcription/deepgram";
import { segmentsToText, TranscriptSession } from "./transcription/session";
import type { TranscriptionProvider } from "./transcription/types";

export interface SecretReader {
  get(name: SecretName): string | null;
  has(name: SecretName): boolean;
}

export interface CaptureInput {
  title: string;
  sourceId: string;
  vision: { mediaType: "image/png" | "image/jpeg"; data: string };
  ocrPng: Buffer;
  thumbnailDataUrl: string;
  /** Low-resolution fingerprint for change detection (live sampling only). */
  fingerprint?: Uint8Array;
}

export interface AppCoreDeps {
  store: Store;
  secrets: SecretReader;
  emitChat: (e: ChatEvent) => void;
  emitTranscript: (e: TranscriptEvent) => void;
  emitApp: (e: AppEvent) => void;
  ocr: OcrEngine | null;
  log?: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void;
  /** Overrides for tests / alternative backends. */
  providerFactory?: (kind: Settings["provider"]["kind"], secrets: SecretReader, settings: Settings) => AIProvider | null;
  transcriptionFactory?: (apiKey: string) => TranscriptionProvider;
  /** Captures one live-screen frame (Electron-only); null when unsupported. */
  liveScreenCapture?: () => Promise<CaptureInput>;
  now?: () => number;
  /** Max time chat waits for in-progress OCR before answering without it. */
  ocrWaitMs?: number;
  /**
   * Whether the labelled development (mock) provider may be used. False in packaged builds unless
   * explicitly enabled, so production never silently answers with simulated output.
   */
  devModeAllowed?: boolean;
}

/**
 * Endpoint overrides (used by the smoke test and self-hosted gateways) must be HTTPS, or plain
 * HTTP/WS only to loopback, so a stray environment variable cannot send keys over the network
 * in clear text.
 */
export function safeEndpoint(url: string | undefined, kind: "http" | "ws"): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    const secure = kind === "http" ? u.protocol === "https:" : u.protocol === "wss:";
    const plain = kind === "http" ? u.protocol === "http:" : u.protocol === "ws:";
    return secure || (plain && loopback) ? url : undefined;
  } catch {
    return undefined;
  }
}

export function defaultProviderFactory(kind: Settings["provider"]["kind"], secrets: SecretReader, settings: Settings): AIProvider | null {
  if (kind === "mock") return new MockProvider();
  if (kind === "openai_compat") {
    const c = settings.provider.openaiCompat;
    return new OpenAICompatProvider({ baseUrl: c.baseUrl, model: c.model, apiKey: secrets.get("openai_compat"), supportsImages: c.supportsImages });
  }
  if (kind === "openai") {
    const key = secrets.get("openai");
    return key ? new OpenAICompatProvider({ flavor: "openai", baseUrl: "https://api.openai.com/v1", model: settings.provider.openai.model, apiKey: key, supportsImages: true }) : null;
  }
  if (kind === "gemini") {
    const key = secrets.get("gemini");
    return key ? new GeminiProvider({ apiKey: key, model: settings.provider.gemini.model }) : null;
  }
  const key = secrets.get("anthropic");
  return key ? new AnthropicProvider({ apiKey: key, baseURL: safeEndpoint(process.env.LUMEN_ANTHROPIC_BASE_URL, "http") }) : null;
}

/**
 * Electron-independent application core: settings, sessions, context, chat, transcription,
 * knowledge and permissions. The Electron main process is a thin IPC layer over this class, which
 * keeps every user workflow testable end-to-end without a GUI.
 */
export class AppCore {
  settings: Settings;
  readonly engine: ContextEngine;
  readonly chat: ChatService;
  readonly metrics = new Metrics();
  readonly liveScreen: LiveScreen;
  live: TranscriptSession | null = null;
  health: ProviderHealth;
  private ocrJobs = new Map<string, Promise<void>>();
  private liveScreenItemId: string | null = null;
  private liveFingerprint: Uint8Array | null = null;
  private readonly now: () => number;

  constructor(
    private readonly deps: AppCoreDeps,
    initial: Settings,
    private readonly persist: (s: Settings) => void = () => undefined,
  ) {
    this.now = deps.now ?? Date.now;
    this.settings = initial;
    this.health = this.initialHealth();
    this.engine = new ContextEngine(
      deps.store,
      {
        screenTtlMinutes: initial.privacy.screenContextTtlMinutes,
        sessionTtlMinutes: (id) => deps.store.getSession(id)?.contextTtlMinutes ?? null,
        isPermitted: (p) => this.isPermitted(p),
        redactSensitive: initial.privacy.redactSensitive,
      },
      this.now,
    );
    this.engine.onChange((sessionId) => deps.emitApp({ type: "context", sessionId, items: this.engine.summaries(sessionId) }));
    this.chat = new ChatService({
      store: deps.store,
      context: this.engine,
      metrics: this.metrics,
      getSettings: () => this.settings,
      getProvider: (session) => this.providerFor(session),
      getLiveTranscript: (sessionId) => this.transcriptContext(sessionId),
      awaitPending: (sessionId) => this.awaitOcr(sessionId),
      emit: (e) => {
        deps.emitChat(e);
        if (e.type === "done" || e.type === "cancelled" || e.type === "error") deps.emitApp({ type: "history-changed" });
      },
      onProviderResult: (ok, code, message) => this.recordHealth(ok, code, message),
      checkBudget: () => this.checkBudget(),
      onUsage: (model, usage, cost) => {
        if (cost > 0) deps.store.recordUsage(model, usage.inputTokens, usage.outputTokens, cost, this.now());
      },
      log: deps.log,
    });
    this.liveScreen = new LiveScreen(
      () => this.liveScreenTick(),
      (s) => deps.emitApp({ type: "live-screen", state: s }),
      () => this.isPermitted("screen"),
      this.now,
    );
    this.ensureActiveSession();
  }

  // ---------------- settings & permissions ----------------

  isPermitted(p: ContextPermission): boolean {
    if (p === "user") return true;
    return this.settings.consent[p];
  }

  updateSettings(patch: unknown): Settings {
    const prev = this.settings;
    const next = applySettingsPatch(this.settings, patch);
    if (next.provider.kind === "mock" && prev.provider.kind !== "mock" && !this.devModeAllowed) {
      throw new Error("Development mode is not available in this build.");
    }
    this.settings = next;
    this.persist(this.settings);
    this.engine.configure({ screenTtlMinutes: this.settings.privacy.screenContextTtlMinutes, redactSensitive: this.settings.privacy.redactSensitive });
    // Revocations take effect immediately: stop the source and discard what it captured.
    if (prev.consent.screen && !this.settings.consent.screen) {
      this.liveScreen.stop();
      this.engine.revoke("screen");
      this.ocrJobs.clear();
      this.deps.emitApp({ type: "permission-revoked", permission: "screen" });
    }
    if (prev.consent.microphone && !this.settings.consent.microphone) {
      if (this.live) this.stopTranscript("Microphone access was turned off.");
      this.engine.revoke("microphone");
      this.deps.emitApp({ type: "permission-revoked", permission: "microphone" });
    }
    if (prev.consent.systemAudio && !this.settings.consent.systemAudio) {
      this.deps.emitApp({ type: "audio-command", command: "system-off", micDeviceId: null, systemAudio: false });
      if (this.settings.transcription.captureSystemAudio) this.settings = applySettingsPatch(this.settings, { transcription: { captureSystemAudio: false } });
      this.engine.revoke("systemAudio");
      this.deps.emitApp({ type: "permission-revoked", permission: "systemAudio" });
    }
    if (prev.provider.kind !== this.settings.provider.kind || prev.provider.model !== this.settings.provider.model || JSON.stringify(prev.provider) !== JSON.stringify(this.settings.provider)) {
      this.health = this.initialHealth();
      this.deps.emitApp({ type: "provider-health", health: this.health });
    }
    this.deps.emitApp({ type: "settings", settings: this.settings });
    return this.settings;
  }

  resetShortcuts(): Settings {
    return this.updateSettings({ shortcuts: DEFAULT_SHORTCUTS });
  }

  // ---------------- spend limit ----------------

  /** Estimated spend since local midnight, from the persisted ledger (survives restarts). */
  spendToday(): { costUsd: number; requests: number; limitUsd: number } {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return { ...this.deps.store.spendSince(d.getTime()), limitUsd: this.settings.provider.dailySpendLimitUsd };
  }

  private checkBudget() {
    const limit = this.settings.provider.dailySpendLimitUsd;
    if (!limit || this.settings.provider.kind === "mock") return;
    const { costUsd } = this.spendToday();
    if (costUsd >= limit) {
      throw new ProviderError(
        `Today's estimated AI spend ($${costUsd.toFixed(2)}) reached your daily limit of $${limit.toFixed(2)}. Raise or remove the limit in AI provider settings.`,
        "spend_limit",
        false,
      );
    }
  }

  // ---------------- providers ----------------

  get devModeAllowed(): boolean {
    return this.deps.devModeAllowed ?? true;
  }

  providerFor(session?: Session | null): AIProvider | null {
    void session;
    if (this.settings.provider.kind === "mock" && !this.devModeAllowed) return null;
    return (this.deps.providerFactory ?? defaultProviderFactory)(this.settings.provider.kind, this.deps.secrets, this.settings);
  }

  private initialHealth(): ProviderHealth {
    const kind = this.settings.provider.kind;
    const model = activeModel(this.settings.provider);
    if (kind === "mock" && !this.devModeAllowed) return { kind, model, state: "unconfigured", message: "Development mode is not available in this build. Choose an AI provider.", checkedAt: null, latencyMs: null };
    if (kind === "mock") return { kind, model, state: "mock", message: "Development mode — answers are mock responses, not AI.", checkedAt: null, latencyMs: null };
    if ((kind === "anthropic" || kind === "openai" || kind === "gemini") && !this.deps.secrets.has(kind)) {
      return { kind, model, state: "unconfigured", message: `No ${PROVIDER_INFO[kind].label} API key configured.`, checkedAt: null, latencyMs: null };
    }
    return { kind, model, state: "unknown", message: "Not checked yet.", checkedAt: null, latencyMs: null };
  }

  private recordHealth(ok: boolean, code?: string, message?: string) {
    const prev = this.health.state;
    this.health = ok
      ? { ...this.health, state: "ok", message: "Connected.", checkedAt: this.now() }
      : { ...this.health, state: code === "auth" ? "down" : "degraded", message: message ?? "The provider had a problem.", checkedAt: this.now() };
    if (prev !== this.health.state || !ok) this.deps.emitApp({ type: "provider-health", health: this.health });
  }

  async testProvider() {
    const p = this.providerFor();
    this.health = this.initialHealth();
    if (!p) return { ok: false, message: this.health.message, latencyMs: null, code: "missing_credentials" as const };
    const res = await p.test(activeModel(this.settings.provider));
    this.health = {
      ...this.health,
      state: p.isMock ? "mock" : res.ok ? "ok" : healthStateFor(res.code),
      message: res.message,
      checkedAt: this.now(),
      latencyMs: res.latencyMs,
    };
    this.deps.emitApp({ type: "provider-health", health: this.health });
    return res;
  }

  // ---------------- sessions ----------------

  get activeSessionId(): string {
    return this.ensureActiveSession().id;
  }

  ensureActiveSession(): Session {
    const id = this.settings.activeSessionId;
    const existing = id ? this.deps.store.getSession(id) : null;
    if (existing) return existing;
    const latest = this.deps.store.listSessions()[0];
    const session = latest ?? this.deps.store.createSession({ title: "My first session", type: this.settings.assistant.mode });
    this.settings = applySettingsPatch(this.settings, { activeSessionId: session.id });
    this.persist(this.settings);
    return session;
  }

  createSession(input: { title: string; type: AssistantMode; notes?: string; contextTtlMinutes?: number | null; ai?: SessionAiConfig }, activate = true): Session {
    const s = this.deps.store.createSession(input);
    if (activate) this.switchSession(s.id);
    else this.deps.emitApp({ type: "sessions-changed" });
    return s;
  }

  updateSession(id: string, patch: Partial<Pick<Session, "title" | "type" | "notes" | "contextTtlMinutes" | "ai">>): Session {
    const s = this.deps.store.updateSession(id, patch);
    if (!s) throw new Error("Session not found.");
    this.deps.emitApp({ type: "sessions-changed" });
    return s;
  }

  /**
   * Switch the active session. In-flight answers for the old session are cancelled so their output
   * cannot land in the new one; context is session-scoped so nothing else needs to move.
   */
  switchSession(id: string): Session {
    const s = this.deps.store.getSession(id);
    if (!s) throw new Error("Session not found.");
    const prev = this.settings.activeSessionId;
    if (prev && prev !== id) this.chat.cancelSession(prev);
    this.settings = applySettingsPatch(this.settings, { activeSessionId: id });
    this.persist(this.settings);
    this.deps.emitApp({ type: "session-switched", sessionId: id });
    this.deps.emitApp({ type: "sessions-changed" });
    this.deps.emitApp({ type: "context", sessionId: id, items: this.engine.summaries(id) });
    return s;
  }

  /**
   * Delete a session and everything stored for it: conversations, messages, transcripts, segments,
   * meeting notes, session documents and their chunks (and all their full-text index rows), plus
   * in-memory context. Global knowledge documents are not affected.
   */
  deleteSession(id: string): void {
    this.chat.cancelSession(id);
    if (this.live?.workspaceSessionId === id) {
      this.stopTranscript();
      this.stopDetector();
      this.copilot.questions.length = 0;
    }
    if (this.liveScreen.snapshot.active && this.settings.activeSessionId === id) this.liveScreen.stop();
    this.engine.dropSession(id);
    this.deps.store.deleteSession(id);
    if (this.settings.activeSessionId === id) {
      this.settings = applySettingsPatch(this.settings, { activeSessionId: null });
      const next = this.ensureActiveSession();
      this.deps.emitApp({ type: "session-switched", sessionId: next.id });
    }
    this.deps.emitApp({ type: "sessions-changed" });
    this.deps.emitApp({ type: "history-changed" });
  }

  /** Remember which conversation is open so a restart (or panel reload) restores it. */
  setOpenConversation(conversationId: string | null) {
    const sid = this.activeSessionId;
    if (conversationId) {
      const c = this.deps.store.getConversation(conversationId);
      if (!c || c.sessionId !== sid) return;
    }
    this.deps.store.setLastConversation(sid, conversationId);
  }

  openConversation(): string | null {
    return this.deps.store.getLastConversation(this.activeSessionId);
  }

  // ---------------- context ----------------

  addText(source: "note" | "clipboard" | "selected_text" | "document", title: string, text: string, opts: { pinned?: boolean; sourceId?: string } = {}) {
    return this.engine.ingest({ sessionId: this.activeSessionId, source, title, text, pinned: opts.pinned, sourceId: opts.sourceId });
  }

  /**
   * Add a screen capture (screenshot, window, region or imported image). OCR runs on-device in the
   * background; when previews are required the item stays "pending" until the user confirms it.
   */
  addCapture(input: CaptureInput, opts: { pending?: boolean; live?: boolean; sessionId?: string } = {}): { record: ContextRecord; ocr: Promise<void> } {
    const sessionId = opts.sessionId ?? this.activeSessionId;
    const record = this.engine.ingest({
      sessionId,
      source: "screenshot",
      sourceId: input.sourceId,
      title: input.title,
      text: "",
      image: input.vision,
      thumbnailDataUrl: input.thumbnailDataUrl,
      pending: opts.pending ?? this.settings.screen.requirePreview,
      permission: "screen",
      ocr: this.settings.screen.ocr && this.deps.ocr ? "running" : "none",
    });
    let job: Promise<void> = Promise.resolve();
    if (this.settings.screen.ocr && this.deps.ocr) {
      const ocr = this.deps.ocr;
      job = ocr
        .recognize(input.ocrPng)
        .then((r) => {
          this.metrics.recordOcr(r.ms);
          // The capture may have been discarded or consent revoked while OCR ran.
          if (this.engine.get(record.id) && this.isPermitted("screen")) this.engine.setOcr(record.id, { text: r.text, confidence: r.confidence });
        })
        .catch((err: Error) => {
          this.deps.log?.("warn", "ocr failed", { message: err.message });
          if (this.engine.get(record.id)) this.engine.setOcr(record.id, { error: err.message });
        })
        .finally(() => this.ocrJobs.delete(record.id));
      this.ocrJobs.set(record.id, job);
    }
    return { record, ocr: job };
  }

  /** Wait (bounded) for OCR still running on this session's active captures. */
  private async awaitOcr(sessionId: string) {
    const jobs = this.engine
      .active(sessionId)
      .filter((r) => this.ocrJobs.has(r.id))
      .map((r) => this.ocrJobs.get(r.id)!);
    if (!jobs.length) return;
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, this.deps.ocrWaitMs ?? 8000))]);
  }

  private async liveScreenTick() {
    if (!this.deps.liveScreenCapture) throw new Error("Live screen context is not supported on this platform.");
    const frame = await this.deps.liveScreenCapture();
    // Skip unchanged screens: no new OCR, no new context item, nothing re-sent.
    if (frame.fingerprint && this.liveScreenItemId && !hasChanged(this.liveFingerprint, frame.fingerprint)) return false;
    this.liveFingerprint = frame.fingerprint ?? null;
    // Replace the previous live frame instead of accumulating captures.
    if (this.liveScreenItemId) this.engine.remove(this.liveScreenItemId);
    const { record, ocr } = this.addCapture({ ...frame, title: `Live screen — ${frame.title}` }, { pending: false, live: true });
    this.liveScreenItemId = record.id;
    await ocr;
    return true;
  }

  startLiveScreen() {
    if (!this.deps.liveScreenCapture) throw new Error("Live screen context is not supported on this platform.");
    this.liveScreen.start(this.settings.screen.liveIntervalSec);
  }

  stopLiveScreen(clear = true) {
    this.liveScreen.stop();
    if (clear && this.liveScreenItemId) this.engine.remove(this.liveScreenItemId);
    this.liveScreenItemId = null;
    this.liveFingerprint = null;
  }

  get liveScreenState(): LiveScreenState {
    return this.liveScreen.snapshot;
  }

  // ---------------- knowledge ----------------

  importKnowledge(paths: string[], scope: "global" | "session"): Promise<KnowledgeImportResult> {
    return importKnowledge(this.deps.store, paths, scope === "session" ? this.activeSessionId : null);
  }

  addKnowledgeText(title: string, text: string, scope: "global" | "session") {
    return addKnowledgeText(this.deps.store, title, text, scope === "session" ? this.activeSessionId : null);
  }

  // ---------------- one-key assistance ----------------

  /**
   * What ⌘/Ctrl+Enter should ask when the input is empty, chosen from the context that actually
   * exists for the active session. Never claims a source that is not available.
   */
  assistPlan(): { prompt: string | null; sources: string[]; missing: string | null; style: AnswerStyle } {
    const sid = this.activeSessionId;
    const session = this.deps.store.getSession(sid);
    const live = this.transcriptContext(sid);
    const recording = !!this.live && this.live.workspaceSessionId === sid && ["recording", "paused", "reconnecting"].includes(this.live.status);
    const items = this.engine.active(sid);
    const pending = this.engine.list(sid).filter((r) => r.status === "pending");
    const screen = items.filter((r) => r.source === "screenshot" || r.source === "ocr");
    const sources: string[] = [];
    if (recording && live?.text.trim()) sources.push("live transcript");
    if (screen.length) sources.push(`${screen.length} screen capture${screen.length > 1 ? "s" : ""}`);
    const other = items.length - screen.length;
    if (other) sources.push(`${other} note/document${other > 1 ? "s" : ""}`);
    const type = session?.type ?? "general";
    if (recording && live?.text.trim()) {
      return {
        prompt: type === "interview"
          ? "Based on the live transcript, what is the most recent question I was asked, and how should I answer it?"
          : "Based on the live transcript, what was just discussed and what should I say or do next?",
        sources,
        missing: null,
        style: type === "interview" ? "suggest" : "quick",
      };
    }
    if (screen.length) {
      return {
        prompt: type === "coding" || type === "technical"
          ? "Look at what is on my screen. Identify the problem or code shown and help me with it."
          : "Look at what is on my screen and tell me what I most likely need to know or do next.",
        sources,
        missing: null,
        style: "quick",
      };
    }
    if (pending.length) return { prompt: null, sources, missing: "Review the screen capture in the panel first (Use this capture), then press ⌘/Ctrl+Enter again.", style: "quick" };
    return {
      prompt: null,
      sources,
      missing: this.settings.consent.screen
        ? "There is nothing to work from yet. Type a question, or start a live transcript."
        : "Type a question, or enable screen context in Permissions so ⌘/Ctrl+Enter can look at your screen.",
      style: "quick",
    };
  }

  // ---------------- interview copilot ----------------

  private detector: QuestionDetector | null = null;
  private detectorTimer: ReturnType<typeof setInterval> | null = null;
  /** Latest auto-suggestion request; superseded ones are cancelled so only the newest question streams. */
  private suggestionRequest: string | null = null;
  private suggestionDone: Promise<void> = Promise.resolve();
  readonly copilot = { questions: [] as DetectedQuestion[] };

  /** Interview profile (résumé, projects, skills…) lives in the knowledge base as tagged documents. */
  profileDocs() {
    return this.deps.store.listKnowledgeDocs(this.activeSessionId).filter((d) => d.format.startsWith("profile:"));
  }

  saveProfileSection(section: ProfileSection, text: string) {
    const existing = this.deps.store.listKnowledgeDocs(null).find((d) => d.format === `profile:${section}`);
    if (existing) this.deps.store.deleteKnowledgeDoc(existing.id);
    const t = text.trim();
    if (!t) return null;
    return this.deps.store.addKnowledgeDoc({ title: PROFILE_SECTIONS[section], source: "profile", chunks: chunkText(normalizeText(t), 1600, 200), sessionId: null, format: `profile:${section}` });
  }

  profileText(): Record<ProfileSection, string> {
    const out = Object.fromEntries(Object.keys(PROFILE_SECTIONS).map((k) => [k, ""])) as Record<ProfileSection, string>;
    for (const d of this.deps.store.listKnowledgeDocs(null)) {
      const sec = d.format.startsWith("profile:") ? (d.format.slice(8) as ProfileSection) : null;
      if (sec && sec in out) out[sec] = this.deps.store.docChunks(d.id).join("\n");
    }
    return out;
  }

  /** Start watching the live transcript of the active session for interviewer questions. */
  private ensureDetector() {
    if (this.detectorTimer) return;
    this.detector = new QuestionDetector({ interviewer: this.settings.interview.interviewer, now: this.now });
    this.detectorTimer = setInterval(() => this.pollQuestions(), 400);
    (this.detectorTimer as { unref?: () => void }).unref?.();
  }

  /** Exposed for lifecycle tests: whether the question detector's poll timer is running. */
  get detectorRunning(): boolean {
    return this.detectorTimer !== null;
  }

  private stopDetector() {
    if (this.detectorTimer) clearInterval(this.detectorTimer);
    this.detectorTimer = null;
    this.detector = null;
  }

  /** Called for every finalized segment. Interim results never trigger suggestions. */
  private onSegment(seg: TranscriptSegment) {
    const session = this.deps.store.getSession(this.live?.workspaceSessionId ?? "");
    if (!session || session.type !== "interview" || this.settings.questions.policy !== "assisted") return;
    this.ensureDetector();
    this.detector!.push(seg);
  }

  /** Exposed for tests: process pending segments now. */
  pollQuestions(force = false) {
    const q = this.detector?.poll(force);
    if (!q || !this.live) return null;
    if (this.live.workspaceSessionId !== this.activeSessionId) return null; // never answer into another session
    this.copilot.questions.push(q);
    if (this.copilot.questions.length > 50) this.copilot.questions.shift();
    // Newest question wins: cancel an in-flight suggestion for an older question and wait for it
    // to settle (it holds the conversation lock) before starting the new one.
    if (this.suggestionRequest) this.chat.cancel(this.suggestionRequest);
    const requestId = `iq-${q.id}`.slice(0, 100);
    this.suggestionRequest = requestId;
    this.deps.emitChat({ type: "suggestion", requestId, question: { id: q.id, text: q.text, category: q.category, categoryLabel: CATEGORY_LABELS[q.category], startMs: q.startMs } });
    const sid = this.activeSessionId;
    this.suggestionDone = this.suggestionDone
      .then(() => {
        if (this.suggestionRequest !== requestId || this.activeSessionId !== sid) return; // superseded or session changed
        return this.sendInterview({ requestId, conversationId: this.deps.store.getLastConversation(sid), question: q.text, category: q.category, length: this.settings.interview.length, tone: this.settings.assistant.tone, includeLiveTranscript: true, questionId: q.id });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.suggestionRequest === requestId) this.suggestionRequest = null;
      });
    return q;
  }

  sendInterview(req: {
    requestId: string;
    conversationId: string | null;
    question: string;
    length: AnswerLength;
    tone?: Tone;
    category?: QuestionCategory;
    includeLiveTranscript?: boolean;
    questionId?: string;
    text?: string;
    style?: AnswerStyle;
  }) {
    const q = req.question.trim();
    const category = req.category ?? classifyQuestion(q).category;
    return this.send({
      requestId: req.requestId,
      conversationId: req.conversationId,
      text: interviewPrompt({ text: q, category }, req.length),
      displayText: q,
      retrievalQuery: q,
      taskInstruction: "Task: interview answer suggestion. Follow the layout in the user's request exactly. Personal facts must come from the user's profile, résumé or notes in context, with citations.",
      origin: { kind: "interview", label: CATEGORY_LABELS[category], questionId: req.questionId },
      style: "suggest",
      tone: req.tone ?? this.settings.assistant.tone,
      includeLiveTranscript: req.includeLiveTranscript ?? true,
    });
  }

  // ---------------- technical assessment ----------------

  /** Parse a problem from pasted text plus any OCR text from this session's screen captures. */
  analyzeProblem(text: string): ParsedProblem {
    let source = text;
    if (!source.trim()) {
      const ocr = this.engine
        .active(this.activeSessionId)
        .filter((r) => (r.source === "screenshot" || r.source === "ocr") && r.text.trim())
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      source = ocr?.text ?? "";
    }
    return parseProblem(source);
  }

  sendTechnical(req: { requestId: string; conversationId: string | null; text: string; task: TechnicalTask; language: Language; problem?: string; tone?: Tone; includeLiveTranscript?: boolean; style?: AnswerStyle; detail?: TechnicalDetail }) {
    const parsed = req.problem?.trim() ? parseProblem(req.problem) : this.analyzeProblem("");
    const sid = this.activeSessionId;
    // The problem statement becomes explicit, session-scoped context (deduped if unchanged), so
    // follow-ups and spoken clarifications are combined with it by the normal pipeline.
    if (req.problem?.trim()) {
      this.engine.ingest({ sessionId: sid, source: "user_message", sourceId: "technical-problem", title: parsed.title ? `Problem: ${parsed.title}` : "Problem statement", text: `${problemToContext(parsed)}`, pinned: true });
    }
    const label = { solve: "Solve", explain: "Explain code", debug: "Debug", review: "Code review", tests: "Test cases", complexity: "Complexity", refactor: "Refactor", hints: "Hints (practice)", system_design: "System design" }[req.task];
    return this.send({
      requestId: req.requestId,
      conversationId: req.conversationId,
      text: technicalPrompt(req.task, req.language, req.problem?.trim() || parsed.statement ? parsed : null, req.text, { level: this.settings.technical.level, detail: req.detail ?? this.settings.technical.detail }),
      retrievalQuery: `${req.text} ${parsed.title ?? ""} ${parsed.statement.slice(0, 400)}`,
      displayText: req.text.trim() || `${label}${parsed.title ? ` — ${parsed.title}` : ""} (${req.language})`,
      taskInstruction: `Task: technical assessment assistance (${req.task}). Follow the requested structure and language conventions exactly. Code goes in fenced blocks. Do not claim to have executed code.`,
      origin: { kind: "technical", label },
      style: req.task === "solve" ? "steps" : "technical",
      tone: req.tone ?? "neutral",
      includeLiveTranscript: req.includeLiveTranscript ?? true,
    });
  }

  // ---------------- notes ----------------

  updateNotes(transcriptId: string, patch: Partial<MeetingInsights>) {
    const t = this.deps.store.getTranscriptSession(transcriptId);
    if (!t || t.sessionId !== this.activeSessionId) throw new Error("That transcript belongs to another session.");
    const cur = this.deps.store.getInsights<MeetingInsights>(transcriptId);
    if (!cur) throw new Error("There are no notes to edit yet.");
    const next = { ...cur, ...patch, sessionId: cur.sessionId, generatedAt: cur.generatedAt, model: cur.model, isMock: cur.isMock, edited: true };
    this.deps.store.updateInsights(transcriptId, next);
    return next;
  }

  exportNotes(transcriptId: string, includeTranscript: boolean): { filename: string; markdown: string } {
    const t = this.deps.store.getTranscriptSession(transcriptId);
    if (!t || t.sessionId !== this.activeSessionId) throw new Error("That transcript belongs to another session.");
    const session = this.deps.store.getSession(t.sessionId);
    const md = notesToMarkdown({ title: t.title, startedAt: t.startedAt, endedAt: t.endedAt, sessionTitle: session?.title }, this.deps.store.getInsights<MeetingInsights>(transcriptId), this.deps.store.listSegments(transcriptId), { includeTranscript });
    return { filename: `${t.title.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "notes"}.md`, markdown: md };
  }

  // ---------------- chat ----------------

  async send(req: Omit<ChatSendRequest, "sessionId"> & { sessionId?: string }) {
    let sessionId: string;
    try {
      sessionId = req.sessionId ?? this.activeSessionId;
    } catch (err) {
      // Resolving the session itself failed (e.g. DB error): still end the request visibly.
      const pe = toUserError(err);
      this.deps.emitChat({ type: "error", requestId: req.requestId, message: pe.message, code: pe.code, retryable: pe.retryable, conversationId: null });
      return;
    }
    return this.chat.send({ ...req, sessionId });
  }

  // ---------------- transcription ----------------

  transcriptContext(sessionId: string): LiveTranscriptContext | null {
    const live = this.live;
    if (live && live.workspaceSessionId === sessionId && live.status !== "error" && live.status !== "stopped") {
      return { transcriptId: live.id, sessionId, title: live.title, text: live.recentTranscript(), startedAt: live.started };
    }
    // Most recent saved transcript of this session (e.g. asking for a summary after the meeting).
    const recent = this.deps.store.listTranscriptSessions(sessionId)[0];
    if (recent && recent.segmentCount > 0) {
      const text = segmentsToText(this.deps.store.listSegments(recent.id)).slice(-12_000);
      return { transcriptId: recent.id, sessionId, title: `${recent.title} (ended)`, text, startedAt: recent.startedAt };
    }
    return null;
  }

  startTranscript(title: string, opts: { systemAudio?: boolean } = {}): TranscriptSession {
    if (this.live && this.live.status !== "stopped" && this.live.status !== "error") return this.live;
    if (!this.settings.consent.microphone) throw new ProviderError("Enable microphone access for Lumen in Permissions first.", "bad_request", false);
    if (this.settings.transcription.kind === "none") throw new ProviderError("Choose a transcription provider in Settings first.", "bad_request", false);
    const key = this.deps.secrets.get("deepgram");
    if (!key) throw new ProviderError("Add a Deepgram API key in Settings → AI provider to record a live transcript.", "missing_credentials", false);
    const systemAudio = (opts.systemAudio ?? this.settings.transcription.captureSystemAudio) && this.settings.consent.systemAudio;
    const sessionId = this.activeSessionId;
    const provider = (this.deps.transcriptionFactory ?? ((k) => new DeepgramProvider(k, undefined, undefined, safeEndpoint(process.env.LUMEN_DEEPGRAM_URL, "ws"))))(key);
    this.live = new TranscriptSession(
      provider,
      this.deps.store,
      (e) => {
        this.deps.emitTranscript(e);
        if (e.type === "segment") this.onSegment(e.segment);
        if (e.type === "status" && (e.status === "stopped" || e.status === "error")) {
          // Flush a question that was still inside its debounce window when recording ended.
          this.pollQuestions(true);
          this.stopDetector();
        }
      },
      {
        workspaceSessionId: sessionId,
        language: this.settings.transcription.language,
        diarize: true,
        channels: systemAudio ? 2 : 1,
        persist: this.settings.transcription.persist,
        vocabulary: this.settings.transcription.vocabulary,
        title: title.trim().slice(0, 120) || `Meeting ${new Date(this.now()).toLocaleString()}`,
      },
      (ms) => this.metrics.recordTranscriptionLatency(ms),
    );
    this.deps.emitApp({ type: "audio-command", command: "start", micDeviceId: this.settings.transcription.microphoneDeviceId, systemAudio });
    this.deps.log?.("info", "transcript started", { transcriptId: this.live.id, channels: systemAudio ? 2 : 1, persisted: this.live.persisted });
    return this.live;
  }

  pauseTranscript() {
    this.live?.pause();
  }

  /** Global pause/resume shortcut. Returns the new state, or "none" when nothing is recording. */
  toggleTranscriptPause(): "paused" | "resumed" | "none" {
    const live = this.live;
    if (!live || live.status === "stopped" || live.status === "error") return "none";
    if (live.status === "paused") {
      live.resume();
      return "resumed";
    }
    live.pause();
    return "paused";
  }

  /** Stop every in-flight answer (global cancel shortcut). Returns how many were stopped. */
  cancelAllAnswers(): number {
    const n = this.chat.activeRequests;
    this.chat.cancelAll();
    return n;
  }

  resumeTranscript() {
    this.live?.resume();
  }

  stopTranscript(reason?: string) {
    this.deps.emitApp({ type: "audio-command", command: "stop", micDeviceId: null, systemAudio: false });
    if (this.live) {
      this.live.stop();
      this.deps.log?.("info", "transcript stopped", { transcriptId: this.live.id });
      if (reason) this.deps.emitApp({ type: "toast", level: "info", message: reason });
    }
  }

  pushAudio(pcm: Uint8Array) {
    // Audio is only accepted while microphone consent is granted.
    if (!this.settings.consent.microphone) return;
    this.live?.pushAudio(pcm);
  }

  liveSegments(transcriptId: string): TranscriptSegment[] | null {
    return this.live && this.live.id === transcriptId ? this.live.liveSegments() : null;
  }

  async generateInsights(transcriptId: string, signal: AbortSignal): Promise<MeetingInsights> {
    const p = this.providerFor();
    if (!p) throw new ProviderError("No API key is configured for the selected AI provider.", "missing_credentials", false);
    const memory = transcriptId.startsWith("mem-") ? this.liveSegments(transcriptId) : null;
    if (transcriptId.startsWith("mem-") && !memory) throw new ProviderError("This in-memory transcript has already been discarded.", "bad_request", false);
    const t = memory ? null : this.deps.store.getTranscriptSession(transcriptId);
    if (!memory && t?.sessionId !== this.activeSessionId) throw new ProviderError("That transcript belongs to another session.", "bad_request", false);
    return generateInsights(p, this.deps.store, this.settings, transcriptId, signal, { segments: memory ?? undefined });
  }

  // ---------------- data ----------------

  deleteAll() {
    this.stopTranscript();
    this.stopLiveScreen();
    this.chat.cancelAll();
    this.deps.store.deleteAll();
    this.engine.dropAll();
    this.settings = applySettingsPatch(this.settings, { activeSessionId: null });
    const s = this.ensureActiveSession();
    this.deps.emitApp({ type: "session-switched", sessionId: s.id });
    this.deps.emitApp({ type: "sessions-changed" });
    this.deps.emitApp({ type: "history-changed" });
  }

  /** Cancel in-flight answers and wait (bounded) for them to record their final state. */
  async shutdown(timeoutMs = 1500) {
    this.stopDetector();
    this.liveScreen.stop();
    if (this.live && this.live.status !== "stopped") this.stopTranscript();
    this.chat.cancelAll();
    const end = Date.now() + timeoutMs;
    while (this.chat.activeRequests > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  }

  sweep() {
    const n = this.engine.sweep();
    const r = this.deps.store.applyRetention(this.settings.privacy.conversationRetentionDays, this.settings.privacy.transcriptRetentionDays, this.now());
    return { ...r, context: n + r.context };
  }
}

/**
 * Health after a failed test: credentials or model access problems need the user ("down");
 * network, rate-limit and provider outages are usually transient ("degraded").
 */
export function healthStateFor(code: ProviderTestResult["code"]): ProviderHealth["state"] {
  return code === "auth" || code === "missing_credentials" || code === "model_unavailable" || code === "bad_request" ? "down" : "degraded";
}
