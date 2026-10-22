import type { ChatEvent, ChatMessage, ChatSendRequest, ErrorCode, Session, Settings } from "../shared/types";
import { citedLabels, type ContextEngine } from "./context/engine";
import { buildPrompt } from "./context/promptBuilder";
import type { Candidate } from "./context/ranker";
import { redact } from "./context/sensitivity";
import { truncate } from "./context/text";
import type { Metrics } from "./metrics";
import { estimateCostUsd, hasPricing } from "./providers/pricing";
import { toUserError } from "./errors";
import { activeModel } from "../shared/defaults";
import { CancelledError, ProviderError, type AIProvider, type GenerateUsage, type ProviderMessage } from "./providers/types";
import type { Store } from "./storage/db";
import { planResponse, type ResponsePlan } from "./intelligence/orchestrator";

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
  /** Throws a ProviderError("spend_limit") when the configured daily budget is exhausted. */
  checkBudget?: () => void;
  onUsage?: (model: string, usage: GenerateUsage, costUsd: number) => void;
  log?: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void;
}

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
    let pendingWaitMs = 0;
    let requestSentMs: number | undefined;

    const fail = (pe: ProviderError) => {
      emit({ type: "error", requestId: req.requestId, message: pe.message, code: pe.code, retryable: pe.retryable || pe.code === "refusal", conversationId });
    };

    // One generation per conversation at a time keeps turn order intact.
    for (const f of this.inflight.values()) {
      if (conversationId && f.conversationId === conversationId) {
        return fail(new ProviderError("Wait for the current answer to finish, or stop it first.", "busy", false));
      }
    }
    this.inflight.set(req.requestId, { ctrl, conversationId, sessionId: req.sessionId });

    // Everything below runs inside try so that every request ends with exactly one terminal event
    // (done / error / cancelled) — the UI never waits forever on a request that failed early.
    try {
      const session = store.getSession(req.sessionId);
      if (!session) throw new ProviderError("This session no longer exists.", "bad_request", false);
      this.deps.checkBudget?.();
      const provider = this.deps.getProvider(session);
      if (!provider) {
        throw new ProviderError(
          "No API key is configured for the selected AI provider. Add one in Settings → AI provider, or switch to development mode.",
          "missing_credentials",
          false,
        );
      }
      model = provider.isMock ? "mock" : activeModel(settings.provider, session.ai.model);

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

      const waitStart = performance.now();
      await this.deps.awaitPending?.(session.id);
      pendingWaitMs = Math.round(performance.now() - waitStart);
      if (ctrl.signal.aborted) throw new CancelledError();

      // ---- understand the turn (deterministic; never blocks chat) ----
      const priorMessages = store.listMessages(convId).filter((m) => m.id !== userMessageId);
      const screenItems = context.active(session.id).filter((r) => r.source === "screenshot" || r.source === "ocr" || r.source === "selected_text" || r.source === "clipboard");
      let plan: ResponsePlan | null = null;
      try {
        plan = planResponse({
          question,
          history: priorMessages,
          settings,
          sessionType: session.type,
          style: session.ai.style ?? req.style,
          depth: req.depth,
          hasScreen: screenItems.some((r) => r.source === "screenshot" || r.source === "ocr"),
          codeInContext: screenItems.some((r) => /```|[{};]\s*$|\b(def|function|class|return|public|SELECT)\b/m.test(r.text)),
          hasWorkflow: !!req.taskInstruction,
        });
      } catch (planErr) {
        this.deps.log?.("warn", "response planning failed; answering without a strategy", { error: (planErr as Error)?.name ?? "Error" });
      }

      // ---- gather candidates (all strictly scoped to this session) ----
      const extra: Candidate[] = [];
      if (session.notes.trim()) {
        extra.push({ id: `session-notes:${session.id}`, kind: "note", title: "Session notes", text: session.notes, createdAt: session.updatedAt, pinned: true, explicit: true, sourceId: session.id });
      }
      const live = req.includeLiveTranscript ? this.deps.getLiveTranscript(session.id) : null;
      if (live && live.sessionId === session.id && live.text.trim()) {
        extra.push({ id: `transcript:${live.transcriptId}`, kind: "transcript", title: `Live transcript — ${live.title}`, text: live.text, createdAt: Date.now(), explicit: true, sourceId: live.transcriptId });
      }
      // Long conversation: turns older than the history window become a compact digest so a
      // follow-up can still refer back to them. New topics don't get it (it would be noise).
      const usable = priorMessages.filter((m) => !m.meta.cancelled && !m.meta.interrupted && m.content.trim());
      const windowSize = plan?.historyMessages ?? 12;
      if (plan && plan.turn.relation !== "new" && usable.length > windowSize) {
        const digest = conversationDigest(usable.slice(0, -windowSize));
        if (digest) extra.push({ id: `digest:${convId}`, kind: "history", title: "Earlier in this conversation", text: digest, createdAt: usable[0]!.createdAt, explicit: true, sourceId: convId });
      }
      const query = req.retrievalQuery?.trim() || (plan && plan.turn.relation !== "new" ? plan.turn.retrievalQuery : question);
      if (settings.assistant.useKnowledgeBase) {
        for (const k of store.searchKnowledge(query, session.id)) {
          extra.push({ id: `kb:${k.chunkId}`, kind: "knowledge", title: k.title, text: k.text, createdAt: 0, sourceId: k.docId, retrieved: true });
        }
      }
      if (settings.assistant.useConversationHistory) {
        for (const hit of store.search(query, session.id, 6, "any")) {
          if (hit.kind !== "message" || hit.parentId === convId) continue;
          const m = store.getMessage(hit.itemId);
          if (m) extra.push({ id: `hist:${m.id}`, kind: "history", title: hit.parentTitle, text: m.content, createdAt: m.createdAt, sourceId: m.id });
        }
      }

      const prepared = context.prepare(session.id, query, extra, { sendImages: settings.screen.sendImages && provider.supportsImages });
      contextPrepMs = prepared.prepMs;
      const style = session.ai.style ?? req.style;
      const built = buildPrompt(question, prepared.ranked, {
        mode: session.type,
        style,
        tone: req.tone,
        availability: prepared.availability,
        sessionTitle: session.title,
      });
      // Mode-specific task instructions are trusted (built by Lumen, never from captured content)
      // and go in the system blocks, after the cached policy.
      if (plan) built.systemBlocks.push({ text: plan.preferences, cache: false });
      if (req.taskInstruction) built.systemBlocks.push({ text: req.taskInstruction, cache: false });
      if (plan) built.systemBlocks.push({ text: plan.strategy.instruction, cache: false });
      const intent = plan
        ? { relation: plan.turn.relation, category: plan.task.category, depth: plan.strategy.depth, label: plan.strategy.label, ambiguous: plan.turn.ambiguous || undefined }
        : { relation: "new" as const, category: "general", depth: settings.personalization.depth, label: "General" };

      // ---- multi-turn history (text only, bounded) ----
      // Follow-ups get the conversation; a new topic keeps only the last exchange.
      const turns: ProviderMessage[] = [];
      let chars = 0;
      for (const m of usable.slice(-windowSize).reverse()) {
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
        userMessageId = store.addMessage({ conversationId: convId, role: "user", content: req.displayText ?? question, references: [], meta: { attachments, style, origin: req.origin } }).id;
      }
      store.touchSession(session.id);
      store.setLastConversation(session.id, convId);

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
        intent,
      });

      requestSentMs = Date.now() - started;
      const result = await provider.generate(
        {
          model: activeModel(settings.provider, session.ai.model),
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

      if (!result.text.trim()) {
        throw new ProviderError("The AI returned an empty answer. Try again, or rephrase the question.", "empty_response", true);
      }
      const cost = estimateCostUsd(result.model, result.usage, hasPricing(result.model) ? null : settings.provider.customPrice);
      this.deps.onUsage?.(result.model, result.usage, cost);
      const cited = citedLabels(result.text, built.references);
      const totalMs = Date.now() - started;
      const saved = store.addMessage({
        conversationId: convId,
        role: "assistant",
        content: result.text,
        references: built.references.filter((r) => cited.includes(r.label)),
        meta: { model: result.model, isMock: provider.isMock, estimatedCostUsd: cost, stopReason: result.stopReason, style, ttftMs: result.ttftMs, totalMs, intent },
      });
      metrics.recordRequest({
        at: started,
        model: result.model,
        ttftMs: result.ttftMs,
        totalMs,
        contextPrepMs,
        pendingWaitMs,
        requestSentMs,
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
        try {
          if (partial && conversationId && store.getConversation(conversationId)) {
            partialMessageId = store.addMessage({ conversationId, role: "assistant", content: partial, references: [], meta: { model, cancelled: true } }).id;
          }
        } catch (saveErr) {
          this.deps.log?.("warn", "could not save stopped answer", { code: toUserError(saveErr).code });
        }
        metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, contextPrepMs, pendingWaitMs, requestSentMs, retries: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "cancelled" });
        emit({ type: "cancelled", requestId: req.requestId, partialMessageId });
        return;
      }
      const pe = toUserError(err);
      // Keep what already streamed so a network drop late in a long answer doesn't lose it.
      if (partial.trim() && conversationId) {
        try {
          if (store.getConversation(conversationId)) store.addMessage({ conversationId, role: "assistant", content: partial, references: [], meta: { model, interrupted: true, stopReason: pe.code } });
        } catch (saveErr) {
          this.deps.log?.("warn", "could not save interrupted answer", { code: toUserError(saveErr).code });
        }
      }
      this.deps.log?.("warn", "chat request failed", { code: pe.code, message: pe.message, cause: err instanceof ProviderError ? undefined : String((err as Error)?.name ?? "error") });
      metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, contextPrepMs, pendingWaitMs, requestSentMs, retries: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "error", errorCode: pe.code });
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

/**
 * Deterministic digest of earlier turns: each question with the first line of its answer and the
 * language of any code. Bounded so a very long conversation stays cheap to send.
 */
export function conversationDigest(messages: ChatMessage[], maxChars = 3000): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const a = messages[i + 1]?.role === "assistant" ? messages[i + 1]! : null;
    const firstLine = a ? (a.content.split("\n").find((l) => l.trim() && !l.startsWith("```")) ?? "").trim() : "";
    const lang = a ? /```([\w+#-]+)/.exec(a.content)?.[1] : undefined;
    lines.push(`- Q: ${truncate(m.content.replace(/\s+/g, " "), 200)}${a ? `\n  A: ${truncate(firstLine, 200)}${lang ? ` (included ${lang} code)` : ""}` : ""}`);
  }
  let out = lines.join("\n");
  // Keep the most recent part when over budget.
  if (out.length > maxChars) out = `…\n${out.slice(out.length - maxChars)}`;
  return out;
}
