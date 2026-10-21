import type { ChatEvent, ChatSendRequest, ContextReference, Settings } from "../shared/types";
import type { ContextStore } from "./context/contextStore";
import { buildPrompt } from "./context/promptBuilder";
import { rankCandidates, type Candidate } from "./context/ranker";
import { truncate } from "./context/text";
import type { Metrics } from "./metrics";
import { estimateCostUsd } from "./providers/pricing";
import { CancelledError, ProviderError, type AIProvider, type ProviderMessage } from "./providers/types";
import type { Store } from "./storage/db";

export interface ChatDeps {
  store: Store;
  context: ContextStore;
  metrics: Metrics;
  getSettings: () => Settings;
  /** Returns null when no provider can be built (e.g. Anthropic selected but no key stored). */
  getProvider: () => AIProvider | null;
  /** Recent live transcript text, or null when no transcript is active. */
  getLiveTranscript: () => { title: string; text: string; startedAt: number } | null;
  emit: (event: ChatEvent) => void;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

const HISTORY_TURNS = 12;
const HISTORY_CHARS = 24_000;

export class ChatService {
  private inflight = new Map<string, AbortController>();

  constructor(private readonly deps: ChatDeps) {}

  cancel(requestId: string): boolean {
    const ctrl = this.inflight.get(requestId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  cancelAll() {
    for (const c of this.inflight.values()) c.abort();
  }

  get activeRequests(): number {
    return this.inflight.size;
  }

  async send(req: ChatSendRequest): Promise<void> {
    const { store, context, metrics, emit } = this.deps;
    const settings = this.deps.getSettings();
    const started = Date.now();
    const ctrl = new AbortController();
    this.inflight.set(req.requestId, ctrl);
    let partial = "";
    let conversationId = req.conversationId;
    let model = settings.provider.model;

    try {
      const provider = this.deps.getProvider();
      if (!provider) {
        emit({
          type: "error",
          requestId: req.requestId,
          code: "missing_credentials",
          retryable: false,
          message: "No Anthropic API key is configured. Add one in Settings → AI provider, or switch to development mode.",
        });
        return;
      }
      if (provider.isMock) model = "mock";

      // ---- resolve conversation + question ----
      let question = req.text.trim();
      let userMessageId: string;
      if (req.retryOfMessageId) {
        const prev = store.getMessage(req.retryOfMessageId);
        if (!prev || prev.role !== "assistant") throw new ProviderError("Nothing to retry.", "bad_request", false);
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
        if (!conversationId || !store.getConversation(conversationId)) {
          conversationId = store.createConversation(truncate(question.replace(/\s+/g, " "), 80), req.mode).id;
        }
        userMessageId = "";
      }
      const convId = conversationId;

      // ---- gather candidates from authorized sources ----
      const candidates: Candidate[] = [...context.active()];
      const live = req.includeLiveTranscript ? this.deps.getLiveTranscript() : null;
      if (live && live.text.trim()) {
        candidates.push({
          id: "live-transcript",
          kind: "transcript",
          title: `Live transcript — ${live.title}`,
          text: live.text,
          createdAt: Date.now(),
          explicit: true,
        });
      }
      if (settings.assistant.useKnowledgeBase) {
        for (const k of store.searchKnowledge(question)) {
          candidates.push({ id: `kb:${k.docId}:${k.text.length}`, kind: "knowledge", title: k.title, text: k.text, createdAt: k.createdAt });
        }
      }
      if (settings.assistant.useConversationHistory) {
        for (const hit of store.search(question, 6)) {
          if (hit.kind !== "message" || hit.parentId === convId) continue;
          const m = store.getMessage(hit.itemId);
          if (m) candidates.push({ id: `hist:${m.id}`, kind: "history", title: hit.parentTitle, text: m.content, createdAt: m.createdAt });
        }
      }

      const ranked = rankCandidates(question, candidates).filter((c) => c.explicit || c.pinned || c.score > 0.6);
      const built = buildPrompt(question, ranked, { mode: req.mode, length: req.length, tone: req.tone });

      // ---- multi-turn history (text only, bounded) ----
      const history = store.listMessages(convId).filter((m) => !m.meta.cancelled && m.id !== userMessageId);
      const turns: ProviderMessage[] = [];
      let chars = 0;
      for (const m of history.slice(-HISTORY_TURNS).reverse()) {
        chars += m.content.length;
        if (chars > HISTORY_CHARS) break;
        turns.unshift({ role: m.role, content: m.content });
      }
      // The API requires alternating roles starting with user.
      while (turns.length && turns[0]!.role !== "user") turns.shift();
      const merged = mergeConsecutive(turns);
      if (merged.at(-1)?.role === "user") merged.pop();

      const userContent = built.userContent.map((p) =>
        p.type === "text" ? p : { type: "image" as const, mediaType: p.mediaType, data: p.data },
      );
      const attachments = ranked.filter((r) => built.included.includes(r.id)).map((r) => `${r.kind}:${r.title}`);
      if (!req.retryOfMessageId) {
        userMessageId = store.addMessage({
          conversationId: convId,
          role: "user",
          content: question,
          references: [],
          meta: { attachments },
        }).id;
      }

      emit({
        type: "start",
        requestId: req.requestId,
        conversationId: convId,
        userMessageId,
        references: built.references,
        provider: { kind: provider.kind, model, isMock: provider.isMock },
        warnings: built.warnings,
      });

      const result = await provider.generate(
        {
          model: settings.provider.model,
          system: built.systemBlocks,
          messages: [...merged, { role: "user", content: userContent }],
          maxTokens: settings.provider.maxTokens,
          effort: settings.provider.effort,
          timeoutMs: settings.provider.timeoutMs,
        },
        ctrl.signal,
        {
          onDelta: (text) => {
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
      const saved = store.addMessage({
        conversationId: convId,
        role: "assistant",
        content: result.text,
        references: built.references.filter((r) => mentions(result.text, r)),
        meta: { model: result.model, isMock: provider.isMock, estimatedCostUsd: cost, stopReason: result.stopReason },
      });
      const totalMs = Date.now() - started;
      metrics.recordRequest({
        at: started,
        model: result.model,
        ttftMs: result.ttftMs,
        totalMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: cost,
        outcome: "ok",
      });
      emit({
        type: "done",
        requestId: req.requestId,
        messageId: saved.id,
        totalMs,
        ttftMs: result.ttftMs,
        stopReason: result.stopReason,
        servedByFallback: result.servedByFallback,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          estimatedCostUsd: cost,
        },
      });
    } catch (err) {
      const totalMs = Date.now() - started;
      if (err instanceof CancelledError || ctrl.signal.aborted) {
        let partialMessageId: string | null = null;
        if (partial && conversationId) {
          partialMessageId = store.addMessage({
            conversationId,
            role: "assistant",
            content: partial,
            references: [],
            meta: { model, cancelled: true },
          }).id;
        }
        metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "cancelled" });
        emit({ type: "cancelled", requestId: req.requestId, partialMessageId });
        return;
      }
      const pe = err instanceof ProviderError ? err : new ProviderError("Something went wrong generating the answer.", "unknown", false);
      this.deps.log?.("warn", "chat request failed", { code: pe.code, message: pe.message });
      metrics.recordRequest({ at: started, model, ttftMs: null, totalMs, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, outcome: "error" });
      emit({ type: "error", requestId: req.requestId, message: pe.message, code: pe.code, retryable: pe.retryable || pe.code === "refusal" });
    } finally {
      this.inflight.delete(req.requestId);
    }
  }
}

function mentions(text: string, ref: ContextReference): boolean {
  return text.includes(`[${ref.label}]`) || text.includes(`[${ref.label},`) || text.includes(` ${ref.label}]`);
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
