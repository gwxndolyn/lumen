import type { ChatEvent, ChatMessage, ChatSendRequest, ErrorCode, Session, Settings } from "../shared/types";
import { citedLabels, type ContextEngine } from "./context/engine";
import { buildPrompt, DEFAULT_BUDGET, type PromptBudget } from "./context/promptBuilder";
import type { Candidate } from "./context/ranker";
import { redact } from "./context/sensitivity";
import { truncate } from "./context/text";
import type { Metrics } from "./metrics";
import { estimateCostUsd, hasPricing } from "./providers/pricing";
import { toUserError } from "./errors";
import { activeModel } from "../shared/defaults";
import { CancelledError, ProviderError, capabilitiesOf, type AIProvider, type GenerateRequest, type GenerateResult, type GenerateUsage, type ProviderMessage } from "./providers/types";
import { decideRoute, protectedKindsOf, type HybridPolicy, type RouteDecision } from "./inference/hybrid";
import type { UsageService } from "./inference/usage";
import { responseKey, type CachedResponse, type LruCache } from "./inference/cache";
import { mergeHits } from "./inference/embeddings";
import { estimateTokens } from "./providers/ollama";
import type { KnowledgeHit } from "../shared/types";
import type { Store } from "./storage/db";
import { planResponse, type ResponsePlan } from "./intelligence/orchestrator";
import { routeModel } from "./intelligence/router";
import { verifyAnswer } from "./intelligence/verify";
import type { TaskCategory } from "./intelligence/classify";

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
  /** Durable user-saved memory relevant to a query (bounded). */
  retrieveMemory?: (query: string) => { id: string; kind: string; text: string; updatedAt: number }[];
  /** Pipeline variations for the Evaluation Lab. Unset in the app, which always uses the defaults. */
  overrides?: PipelineOverrides;
  /**
   * Hybrid local/cloud inference. When set it replaces `getProvider`: the router picks the target
   * for each request from the user's policy and what the request contains.
   */
  targets?: (session: Session) => Promise<InferenceTargets>;
  /** Central usage accounting and limits. When set it replaces `checkBudget` / `onUsage`. */
  usage?: UsageService;
  /** In-memory response cache (only consulted when the user enabled it). */
  responseCache?: LruCache<CachedResponse>;
  /** Optional semantic knowledge search (local embeddings). null = unavailable; keyword search is used. */
  semanticKnowledge?: (query: string, sessionId: string, signal: AbortSignal) => Promise<KnowledgeHit[] | null>;
}

export interface InferenceTargets {
  policy: HybridPolicy;
  selectedKind: string;
  cloud: AIProvider | null;
  cloudLabel: string;
  local: AIProvider | null;
  localLabel: string;
  /** Why the local model is not usable, when it isn't. */
  localReason?: string;
}

export interface PipelineOverrides {
  basePrompt?: string;
  budget?: PromptBudget;
  /** false skips the post-generation answer checks. */
  verification?: boolean;
}

const HISTORY_CHARS = 24_000;
const RECENT_REQUEST_IDS = 500;

export class ChatService {
  private inflight = new Map<string, { ctrl: AbortController; conversationId: string | null; sessionId: string; cancelAt?: number; release?: () => void }>();
  /** Recently seen request ids — repeated IPC events with the same id are ignored. */
  private seen = new Set<string>();

  constructor(private readonly deps: ChatDeps) {}

  cancel(requestId: string): boolean {
    const f = this.inflight.get(requestId);
    if (!f) return false;
    this.abort(f);
    return true;
  }

  private abort(f: { ctrl: AbortController; cancelAt?: number }) {
    f.cancelAt ??= performance.now();
    f.ctrl.abort();
  }

  cancelAll() {
    for (const f of this.inflight.values()) this.abort(f);
  }

  /** Cancel in-flight requests belonging to a session (used on session switch / delete). */
  cancelSession(sessionId: string) {
    for (const f of this.inflight.values()) if (f.sessionId === sessionId) this.abort(f);
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
      if (!this.deps.usage) this.deps.checkBudget?.();
      const targets = this.deps.targets ? await this.deps.targets(session) : null;
      // Before routing, use the provider that would serve a request with no protected context, so
      // image handling and model labels match the likely target.
      let provider: AIProvider | null = targets
        ? targets.policy.mode === "local_first" || targets.selectedKind === "ollama"
          ? (targets.local ?? targets.cloud)
          : (targets.cloud ?? targets.local)
        : this.deps.getProvider(session);
      if (!provider) {
        if (targets?.selectedKind === "ollama" || (targets && targets.policy.mode !== "manual" && !targets.cloud))
          throw new ProviderError(`No local model is ready${targets.localReason ? `: ${targets.localReason}` : ""}. Set one up in Settings → AI provider → Local model.`, "missing_credentials", false);
        throw new ProviderError("No API key is configured for the selected AI provider. Add one in Settings → AI provider, or switch to development mode.", "missing_credentials", false);
      }
      model = provider.isMock ? "mock" : modelFor(provider, settings, session.ai.model);
      const releaseSlot = this.deps.usage?.acquire();
      this.inflight.get(req.requestId)!.release = releaseSlot;

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
      // Stop must take effect immediately, not after the (bounded) OCR wait.
      if (this.deps.awaitPending) await untilAborted(this.deps.awaitPending(session.id), ctrl.signal);
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
        extra.push({
          id: `transcript:${live.transcriptId}`,
          kind: "transcript",
          title: `Live transcript — ${live.title}`,
          text: live.text,
          createdAt: Date.now(),
          explicit: true,
          sourceId: live.transcriptId,
        });
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
        const keyword = store.searchKnowledge(query, session.id);
        const semantic = this.deps.semanticKnowledge ? await this.deps.semanticKnowledge(query, session.id, ctrl.signal).catch(() => null) : null;
        if (ctrl.signal.aborted) throw new CancelledError();
        for (const k of mergeHits(keyword, semantic)) {
          extra.push({ id: `kb:${k.chunkId}`, kind: "knowledge", title: k.title, text: k.text, createdAt: 0, sourceId: k.docId, retrieved: true });
        }
      }
      if (settings.assistant.useProjectMemory) {
        for (const m of this.deps.retrieveMemory?.(query) ?? []) {
          // MemoryService has already chosen and bounded these (keyword matches plus standing
          // preferences/conventions), so the ranker must not drop the ones with no keyword overlap.
          extra.push({ id: `mem:${m.id}`, kind: "memory", title: m.kind.replace("_", " "), text: m.text, createdAt: m.updatedAt, sourceId: m.id, retrieved: true, explicit: true });
        }
      }
      if (settings.assistant.useConversationHistory) {
        for (const hit of store.search(query, session.id, 6, "any")) {
          if (hit.kind !== "message" || hit.parentId === convId) continue;
          const m = store.getMessage(hit.itemId);
          // Found by the full-text index, so it keeps the retrieved floor like knowledge passages.
          if (m) extra.push({ id: `hist:${m.id}`, kind: "history", title: hit.parentTitle, text: m.content, createdAt: m.createdAt, sourceId: m.id, retrieved: true });
        }
      }

      const prepared = context.prepare(session.id, query, extra, { sendImages: settings.screen.sendImages && provider.supportsImages });
      contextPrepMs = prepared.prepMs;
      const style = session.ai.style ?? req.style;
      const overrides = this.deps.overrides ?? {};
      const budget = overrides.budget ?? { ...DEFAULT_BUDGET, maxContextChars: settings.limits.maxContextChars, maxItemChars: Math.min(DEFAULT_BUDGET.maxItemChars, settings.limits.maxContextChars) };
      const built = buildPrompt(question, prepared.ranked, {
        mode: session.type,
        style,
        tone: req.tone,
        availability: prepared.availability,
        sessionTitle: session.title,
        query,
        budget,
        basePrompt: overrides.basePrompt,
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

      // ---- hybrid routing (local vs cloud), privacy enforcement ----
      let decision: RouteDecision | null = null;
      let fallbackProvider: AIProvider | null = null;
      if (targets) {
        const sent = prepared.ranked.filter((r) => built.included.includes(r.id));
        const imageOnly = sent.some((r) => r.image && !r.text.trim());
        const estimatedTokens = estimateTokens(built.systemBlocks.map((b) => b.text).join("") + JSON.stringify(merged) + built.userContent.map((p) => (p.type === "text" ? p.text : "")).join(""));
        const cap = (p: AIProvider | null) => (p ? capabilitiesOf(p) : null);
        const cloudCap = cap(targets.cloud);
        const localCap = cap(targets.local);
        decision = decideRoute(
          targets.policy,
          {
            protectedKinds: protectedKindsOf(sent.map((r) => r.kind)),
            needsVision: imageOnly,
            estimatedTokens,
            category: (plan?.task.category ?? "general") as TaskCategory,
            depth: plan?.strategy.depth ?? settings.personalization.depth,
          },
          {
            selectedKind: targets.selectedKind,
            cloud: { ready: !!targets.cloud, vision: !!cloudCap?.vision, contextTokens: cloudCap?.contextTokens ?? null, label: targets.cloudLabel },
            local: { ready: !!targets.local, vision: !!localCap?.vision, contextTokens: localCap?.contextTokens ?? null, label: targets.localLabel, reason: targets.localReason },
          },
        );
        if (!decision.route) throw new ProviderError([decision.reason, ...decision.alternatives].join(" "), "routing_blocked", false);
        provider = decision.route === "local" ? targets.local! : targets.cloud!;
        fallbackProvider = decision.fallback === "local" ? targets.local : decision.fallback === "cloud" ? targets.cloud : null;
        model = provider.isMock ? "mock" : modelFor(provider, settings, session.ai.model);
        this.deps.log?.("info", "inference routed", { route: decision.route, mode: targets.policy.mode, fallback: decision.fallback });
      }
      const active: AIProvider = provider;
      const configuredModel = modelFor(active, settings, session.ai.model);
      const route =
        active.isMock || active.kind === "ollama"
          ? { model: configuredModel, routed: false, reason: "Development mode." }
          : routeModel({
              mode: settings.provider.routing,
              providerKind: active.kind,
              configuredModel,
              category: (plan?.task.category ?? "general") as TaskCategory,
              depth: plan?.strategy.depth ?? settings.personalization.depth,
              needsVision: userContent.some((p) => p.type === "image"),
              estimatedInputTokens: Math.ceil((built.contextChars + question.length + chars) / 4),
              sessionPinned: !!session.ai.model,
            });
      if (route.routed) {
        model = route.model;
        this.deps.log?.("info", "model routed", { from: configuredModel, to: route.model, category: plan?.task.category });
      }
      emit({
        type: "start",
        requestId: req.requestId,
        sessionId: session.id,
        conversationId: convId,
        userMessageId,
        references: built.references,
        provider: { kind: active.kind, model, isMock: active.isMock },
        routing: decision ? { route: decision.route!, reason: decision.reason, leavesDevice: decision.leavesDevice } : undefined,
        warnings: built.warnings,
        availability: prepared.availability,
        contextPrepMs,
        intent,
        selection: {
          considered: prepared.considered,
          included: built.included.length,
          droppedForBudget: built.dropped.length,
          belowRelevance: Math.max(0, prepared.considered - prepared.ranked.length),
          contextChars: built.contextChars,
          budgetChars: budget.maxContextChars,
        },
      });

      requestSentMs = Date.now() - started;
      const genReq: GenerateRequest = {
        model: route.model,
        system: built.systemBlocks,
        messages: [...merged, { role: "user", content: userContent }],
        maxTokens: settings.provider.maxTokens,
        effort: session.ai.effort ?? settings.provider.effort,
        timeoutMs: settings.provider.timeoutMs,
        idleTimeoutMs: settings.provider.idleTimeoutMs,
        retryPolicy: { maxAttempts: settings.limits.maxAttempts, retryTimeouts: settings.limits.retryTimeouts },
      };
      const hooks = {
        onDelta: (text: string) => {
          if (ctrl.signal.aborted) return;
          partial += text;
          emit({ type: "delta", requestId: req.requestId, text });
        },
        onRetry: (attempt: number, delayMs: number, reason: string) => {
          partial = "";
          emit({ type: "retrying", requestId: req.requestId, attempt, delayMs, reason });
        },
      };
      const inputEstimate = estimateTokens(JSON.stringify(genReq.messages) + genReq.system.map((b) => b.text).join(""));
      const useCache = settings.inference.responseCache && !!this.deps.responseCache && !active.isMock;
      const cacheKey = useCache
        ? responseKey({ kind: active.kind, model: genReq.model, system: genReq.system.map((b) => b.text), messages: genReq.messages, maxTokens: genReq.maxTokens, effort: genReq.effort })
        : null;
      const cached = cacheKey ? this.deps.responseCache!.get(cacheKey) : undefined;
      let servedBy: AIProvider = active;
      let fellBack = false;
      let result: GenerateResult;
      if (cached) {
        hooks.onDelta(cached.text);
        result = {
          text: cached.text,
          model: cached.model,
          stopReason: cached.stopReason,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          servedByFallback: null,
          ttftMs: 0,
          retries: 0,
        };
      } else {
        this.deps.usage?.check({ sessionId: session.id, kind: active.kind, model: genReq.model, inputTokens: inputEstimate, maxOutputTokens: genReq.maxTokens });
        const genStarted = Date.now();
        try {
          result = await active.generate(genReq, ctrl.signal, hooks);
        } catch (first) {
          // Policy-approved fallback only, never after text streamed, never on cancel/limit/privacy errors.
          const pe = first instanceof ProviderError ? first : null;
          const eligible =
            !!fallbackProvider &&
            !partial &&
            !ctrl.signal.aborted &&
            !!pe &&
            ["network", "timeout", "overloaded", "rate_limited", "auth", "context_too_large", "missing_credentials"].includes(pe.code);
          if (!eligible) {
            this.recordUsage(active, genReq.model, null, session.id, plan?.task.category ?? null, first, Date.now() - genStarted);
            throw first;
          }
          this.recordUsage(active, genReq.model, null, session.id, plan?.task.category ?? null, first, Date.now() - genStarted);
          servedBy = fallbackProvider!;
          fellBack = true;
          const fbModel = modelFor(servedBy, settings, undefined);
          emit({
            type: "retrying",
            requestId: req.requestId,
            attempt: 1,
            delayMs: 0,
            reason: `${pe!.message} Trying ${servedBy.kind === "ollama" ? "the local model on this device" : `the cloud provider (${fbModel})`} as your fallback setting allows.`,
          });
          this.deps.usage?.check({ sessionId: session.id, kind: servedBy.kind, model: fbModel, inputTokens: inputEstimate, maxOutputTokens: genReq.maxTokens });
          model = fbModel;
          result = await servedBy.generate({ ...genReq, model: fbModel }, ctrl.signal, hooks);
        }
        if (cacheKey && result.text.trim() && result.stopReason !== "max_tokens")
          this.deps.responseCache!.set(cacheKey, { text: result.text, model: result.model, stopReason: result.stopReason }, { tag: session.id, costMs: Date.now() - genStarted });
      }

      if (!result.text.trim()) {
        throw new ProviderError("The AI returned an empty answer. Try again, or rephrase the question.", "empty_response", true);
      }
      let cost: number;
      if (cached) cost = 0;
      else if (this.deps.usage)
        cost = this.deps.usage.record({
          kind: servedBy.kind,
          model: result.model,
          usage: result.usage,
          usageBasis: capabilitiesOf(servedBy).usage === "reported" ? "reported" : "estimated",
          sessionId: session.id,
          category: plan?.task.category ?? null,
          outcome: "ok",
          retries: result.retries,
          latencyMs: Date.now() - started,
        }).usd;
      else {
        cost = estimateCostUsd(result.model, result.usage, hasPricing(result.model) ? null : settings.provider.customPrice);
        this.deps.onUsage?.(result.model, result.usage, cost);
      }
      const cited = citedLabels(result.text, built.references);
      const checks =
        overrides.verification === false
          ? { checksRun: [], findings: [] }
          : verifyAnswer({
              answer: result.text,
              references: built.references,
              category: (plan?.task.category ?? "general") as TaskCategory,
              depth: plan?.strategy.depth ?? settings.personalization.depth,
              requestedLanguage: plan?.turn.requestedLanguage ?? null,
              available: { transcript: prepared.availability.transcript === "live", screen: prepared.availability.screen > 0 },
              hintsOnly: !!plan?.strategy.hintsOnly,
              stopReason: result.stopReason,
            });
      const verification = { checksRun: checks.checksRun.length, findings: checks.findings };
      if (checks.findings.length) this.deps.log?.("info", "answer checks flagged", { checks: checks.findings.map((f) => f.check) });
      metrics.recordVerification(
        checks.checksRun.length,
        checks.findings.map((f) => f.check),
      );
      const totalMs = Date.now() - started;
      const saved = store.addMessage({
        conversationId: convId,
        role: "assistant",
        content: result.text,
        references: built.references.filter((r) => cited.includes(r.label)),
        meta: {
          model: result.model,
          isMock: servedBy.isMock,
          estimatedCostUsd: cost,
          stopReason: result.stopReason,
          style,
          ttftMs: result.ttftMs,
          totalMs,
          intent,
          verification,
          routedFrom: route.routed ? configuredModel : undefined,
          route: decision ? (fellBack ? decision.fallback! : decision.route!) : undefined,
          cached: cached ? true : undefined,
          fellBack: fellBack || undefined,
        },
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
      if (!servedBy.isMock && servedBy === targets?.cloud) this.deps.onProviderResult?.(true);
      else if (!targets && !servedBy.isMock) this.deps.onProviderResult?.(true);
      emit({
        type: "done",
        requestId: req.requestId,
        messageId: saved.id,
        totalMs,
        ttftMs: result.ttftMs,
        stopReason: result.stopReason,
        servedByFallback: result.servedByFallback,
        citedLabels: cited,
        verification,
        routedFrom: route.routed ? configuredModel : undefined,
        cached: cached ? true : undefined,
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
        metrics.recordRequest({
          at: started,
          model,
          ttftMs: null,
          totalMs,
          contextPrepMs,
          pendingWaitMs,
          requestSentMs,
          retries: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          outcome: "cancelled",
        });
        emit({ type: "cancelled", requestId: req.requestId, partialMessageId });
        const cancelAt = this.inflight.get(req.requestId)?.cancelAt;
        if (cancelAt !== undefined) metrics.recordCancel(performance.now() - cancelAt);
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
      metrics.recordRequest({
        at: started,
        model,
        ttftMs: null,
        totalMs,
        contextPrepMs,
        pendingWaitMs,
        requestSentMs,
        retries: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        outcome: "error",
        errorCode: pe.code,
      });
      if (["network", "timeout", "overloaded", "auth", "rate_limited"].includes(pe.code)) this.deps.onProviderResult?.(false, pe.code, pe.message);
      fail(pe);
    } finally {
      this.inflight.get(req.requestId)?.release?.();
      this.inflight.delete(req.requestId);
    }
  }

  /** Record a failed attempt (no tokens reported) so failure and retry rates are real. */
  private recordUsage(p: AIProvider, model: string, usage: GenerateUsage | null, sessionId: string, category: string | null, err: unknown, latencyMs: number) {
    if (!this.deps.usage || p.isMock) return;
    const cancelled = err instanceof CancelledError;
    this.deps.usage.record({
      kind: p.kind,
      model,
      usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usageBasis: "estimated",
      sessionId,
      category,
      outcome: cancelled ? "cancelled" : "error",
      retries: 0,
      latencyMs,
    });
  }
}

/** Model id for whichever provider serves the request. */
function modelFor(p: AIProvider, settings: Settings, override: string | undefined): string {
  if (p.isMock) return "mock";
  if (p.kind === "ollama") return settings.inference.local.model;
  return activeModel({ ...settings.provider, kind: p.kind }, override);
}

/** Resolve when `p` settles or `signal` aborts, whichever comes first. */
function untilAborted(p: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    p.then(done, done);
  });
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
