import type { ChatEvent, ChatSendRequest, ErrorCode, Session, Settings } from "../shared/types";
import { citedLabels, type ContextEngine } from "./context/engine";
import { buildPrompt } from "./context/promptBuilder";
import type { Candidate } from "./context/ranker";
import { redact } from "./context/sensitivity";
import { truncate } from "./context/text";
import type { Metrics } from "./metrics";
import { estimateCostUsd } from "./providers/pricing";
import { CancelledError, ProviderError, type AIProvider, type ProviderMessage } from "./providers/types";
import type { Store } from "./storage/db";

export interface LiveTranscriptContext {
  transcriptId: string;
  /** Workspace session the recording belongs to. Only that session may see it. */
  sessionId: string;
  title: string;
  text: string;
  startedAt: number;
}

export interface ChatDeps {
  store: Store;
  context: ContextEngine;
  metrics: Metrics;
  getSettings: () => Settings;
  /** Returns null when no provider can be built (e.g. Anthropic selected but no key stored). */
  getProvider: (session: Session) => AIProvider | null;
  /** Live (or most recent) transcript of the given session, or null when none exists. */
  getLiveTranscript: (sessionId: string) => LiveTranscriptContext | null;
  /** Wait (bounded) for context still being processed, e.g. OCR of a capture taken just before asking. */
  awaitPending?: (sessionId: string) => Promise<void>;
  emit: (event: ChatEvent) => void;
  onProviderResult?: (ok: boolean, code?: ErrorCode, message?: string) => void;
  log?: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void;
}

const HISTORY_TURNS = 12;
const HISTORY_CHARS = 24_000;
const RECENT_REQUEST_IDS = 500;

export class ChatService {
  private inflight = new Map<string, { ctrl: AbortController; conversationId: string | null; sessionId: string }>();
  /** Recently seen request ids — repeated IPC events with the same id are ignored. */
  private seen = new Set<string>();

  constructor(private readonly deps: ChatDeps) {}

  cancel(requestId: string): boolean {
    const f = this.inflight.get(requestId);
    if (!f) return false;
    f.ctrl.abort();
    return true;
  }

  cancelAll() {
    for (const f of this.inflight.values()) f.ctrl.abort();
  }

  /** Cancel in-flight requests belonging to a session (used on session switch / delete). */
  cancelSession(sessionId: string) {
    for (const f of this.inflight.values()) if (f.sessionId === sessionId) f.ctrl.abort();
  }

  get activeRequests(): number {
    return this.inflight.size;
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > RECENT_REQUEST_IDS) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  async send(req: ChatSendRequest): Promise<void> {
    const { store, context, metrics, emit } = this.deps;
    // Duplicate events (double Enter, re-sent IPC) must not start a second generation.
    if (!this.remember(req.requestId)) {
      this.deps.log?.("debug", "duplicate chat request ignored", { requestId: req.requestId });
      return;
    }
    const settings = this.deps.getSettings();
    const started = Date.now();
    const ctrl = new AbortController();
    let partial = "";
    let conversationId = req.conversationId;
    let model = settings.provider.model;
    let contextPrepMs = 0;

    const fail = (pe: ProviderError) => {
      emit({ type: "error", requestId: req.requestId, message: pe.message, code: pe.code, retryable: pe.retryable || pe.code === "refusal", conversationId });
    };

    const session = store.getSession(req.sessionId);
    if (!session) return fail(new ProviderError("This session no longer exists.", "bad_request", false));

    // One generation per conversation at a time keeps turn order intact.
    for (const f of this.inflight.values()) {
      if (conversationId && f.conversationId === conversationId) {
        return fail(new ProviderError("Wait for the current answer to finish, or stop it first.", "busy", false));
      }
    }
    this.inflight.set(req.requestId, { ctrl, conversationId, sessionId: session.id });

    try {
      const provider = this.deps.getProvider(session);
      if (!provider) {
        throw new ProviderError(
          "No API key is configured for the selected AI provider. Add one in Settings → AI provider, or switch to development mode.",
          "missing_credentials",
          false,
        );
      }
      model = provider.isMock ? "mock" : (session.ai.model ?? (provider.kind === "openai_compat" ? settings.provider.openaiCompat.model : settings.provider.model));

      // ---- resolve conversation + question ----
      let question = req.text.trim();
      let userMessageId = "";
      if (req.retryOfMessageId) {
        const prev = store.getMessage(req.retryOfMessageId);
        const prevConv = prev ? store.getConversation(prev.conversationId) : null;
        if (!prev || prev.role !== "assistant" || prevConv?.sessionId !== session.id) throw new ProviderError("Nothing to retry.", "bad_request", false);
        conversationId = prev.conversationId;
        const msgs = store.listMessages(conversationId);
        const idx = msgs.findIndex((m) => m.id === prev.id);
        const user = msgs.slice(0, idx).findLast((m) => m.role === "user");
        if (!user) throw new ProviderError("Nothing to retry.", "bad_request", false);
        question = user.content;
        userMessageId = user.id;
        store.deleteMessage(prev.id);
      } else {
        if (!question) throw new ProviderError("Type a question first.", "bad_request", false);
        if (question.length > 20_000) throw new ProviderError("The question is too long (max 20,000 characters).", "bad_request", false);
        const existing = conversationId ? store.getConversation(conversationId) : null;
        // A conversation from another session is never continued — start a fresh one instead.
        if (!existing || existing.sessionId !== session.id) {
          conversationId = store.createConversation(session.id, truncate(question.replace(/\s+/g, " "), 80), session.type).id;
        }
      }
      const convId = conversationId!;
      this.inflight.get(req.requestId)!.conversationId = convId;

      await this.deps.awaitPending?.(session.id);
      if (ctrl.signal.aborted) throw new CancelledError();

      // ---- gather candidates (all strictly scoped to this session) ----
      const extra: Candidate[] = [];
      if (session.notes.trim()) {
        extra.push({ id: `session-notes:${session.id}`, kind: "note", title: "Session notes", text: session.notes, createdAt: session.updatedAt, pinned: true, explicit: true, sourceId: session.id });
      }
      const live = req.includeLiveTranscript ? this.deps.getLiveTranscript(session.id) : null;
      if (live && live.sessionId === session.id && live.text.trim()) {
        extra.push({ id: `transcript:${live.transcriptId}`, kind: "transcript", title: `Live transcript — ${live.title}`, text: live.text, createdAt: Date.now(), explicit: true, sourceId: live.transcriptId });
      }
      if (settings.assistant.useKnowledgeBase) {
        for (const k of store.searchKnowledge(question, session.id)) {
          extra.push({ id: `kb:${k.chunkId}`, kind: "knowledge", title: k.title, text: k.text, createdAt: 0, sourceId: k.docId });
        }
      }
      if (settings.assistant.useConversationHistory) {
        for (const hit of store.search(question, session.id, 6, "any")) {
          if (hit.kind !== "message" || hit.parentId === convId) continue;
          const m = store.getMessage(hit.itemId);
          if (m) extra.push({ id: `hist:${m.id}`, kind: "history", title: hit.parentTitle, text: m.content, createdAt: m.createdAt, sourceId: m.id });
        }
      }

      const prepared = context.prepare(session.id, question, extra, { sendImages: settings.screen.sendImages && provider.supportsImages });
      contextPrepMs = prepared.prepMs;
      const style = session.ai.style ?? req.style;
      const built = buildPrompt(question, prepared.ranked, {
        mode: session.type,
        style,
        tone: req.tone,
        availability: prepared.availability,
        sessionTitle: session.title,
      });

      // ---- multi-turn history (text only, bounded) ----
      const history = store.listMessages(convId).filter((m) => !m.meta.cancelled && m.id !== userMessageId && m.content.trim());
      const turns: ProviderMessage[] = [];
      let chars = 0;
      for (const m of history.slice(-HISTORY_TURNS).reverse()) {
        chars += m.content.length;
        if (chars > HISTORY_CHARS) break;
        turns.unshift({ role: m.role, content: settings.privacy.redactSensitive ? redact(m.content) : m.content });
      }
      // The API requires alternating roles starting with user.
      while (turns.length && turns[0]!.role !== "user") turns.shift();
      const merged = mergeConsecutive(turns);
      if (merged.at(-1)?.role === "user") merged.pop();

      const userContent = built.userContent.map((p) => (p.type === "text" ? p : { type: "image" as const, mediaType: p.mediaType, data: p.data }));
      const attachments = prepared.ranked.filter((r) => built.included.includes(r.id)).map((r) => `${r.kind}:${r.title}`);
      if (!req.retryOfMessageId) {
        userMessageId = store.addMessage({ conversationId: convId, role: "user", content: question, references: [], meta: { attachments, style } }).id;
      }
      store.touchSession(session.id);

      emit({
        type: "start",
        requestId: req.requestId,
        sessionId: session.id,
        conversationId: convId,
        userMessageId,
        references: built.references,
        provider: { kind: provider.kind, model, isMock: provider.isMock },
        warnings: built.warnings,
        availability: prepared.availability,
        contextPrepMs,
      });

      const result = await provider.generate(
        {
          model: provider.kind === "openai_compat" ? settings.provider.openaiCompat.model : (session.ai.model ?? settings.provider.model),
          system: built.systemBlocks,
          messages: [...merged, { role: "user", content: userContent }],
          maxTokens: settings.provider.maxTokens,
          effort: session.ai.effort ?? settings.provider.effort,
          timeoutMs: settings.provider.timeoutMs,
          idleTimeoutMs: settings.provider.idleTimeoutMs,
        },
        ctrl.signal,
        {
          onDelta: (text) => {
            if (ctrl.signal.aborted) return;
            partial += text;
            emit({ type: "delta", requestId: req.requestId, text });
          },
          onRetry: (attempt, delayMs, reason) => {
            partial = "";
            emit({ type: "retrying", requestId: req.requestId, attempt, delayMs, reason });
          },
        },
      );

      const cost = estimateCostUsd(result.model, result.usage);
      const cited = citedLabels(result.text, built.references);
      const totalMs = Date.now() - started;
      const saved = store.addMessage({
        conversationId: convId,
        role: "assistant",
        content: result.text,
        references: built.references.filter((r) => cited.includes(r.label)),
        meta: { model: result.model, isMock: provider.isMock, estimatedCostUsd: cost, stopReason: result.stopReason, style, ttftMs: result.ttftMs, totalMs },
      });
      metrics.recordRequest({
        at: started,
        model: result.model,
        ttftMs: result.ttftMs,
        totalMs,
        contextPrepMs,
        retries: result.retries,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: cost,
        outcome: "ok",
      });
      if (!provider.isMock) this.deps.onProviderResult?.(true);
      emit({
        type: "done",
        requestId: req.requestId,
        messageId: saved.id,
        totalMs,
        ttftMs: result.ttftMs,
        stopReason: result.stopReason,
        servedByFallback: result.servedByFallback,
        citedLabels: cited,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, estimatedCostUsd: cost },
      });
    } catch (err) {
      const totalMs = Date.now() - started;
      if (err instanceof CancelledError || ctrl.signal.aborted) {
        let partialMessageId: string | null = null;
        if (partial && conversationId && store.getConversation(conversationId)) {
          partialMessageId = store.addMessage({ conversationId, role: "assistant", content: partial, references: [], meta: { model, cancelled: true } }).id;
        }
        metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, contextPrepMs, retries: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "cancelled" });
        emit({ type: "cancelled", requestId: req.requestId, partialMessageId });
        return;
      }
      const pe = err instanceof ProviderError ? err : new ProviderError("Something went wrong generating the answer.", "unknown", false);
      this.deps.log?.("warn", "chat request failed", { code: pe.code, message: pe.message });
      metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, contextPrepMs, retries: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "error", errorCode: pe.code });
      if (["network", "timeout", "overloaded", "auth", "rate_limited"].includes(pe.code)) this.deps.onProviderResult?.(false, pe.code, pe.message);
      fail(pe);
    } finally {
      this.inflight.delete(req.requestId);
    }
  }
}

function mergeConsecutive(turns: ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const t of turns) {
    const prev = out.at(-1);
    if (prev && prev.role === t.role && typeof prev.content === "string" && typeof t.content === "string") {
      prev.content = `${prev.content}\n\n${t.content}`;
    } else out.push({ ...t });
  }
  return out;
}
