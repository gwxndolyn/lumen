import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppEvent, TranscriptState } from "../../shared/api";
import type {
  AnswerStyle,
  AudioInputState,
  ChatMessage,
  ContextItemSummary,
  ContextReference,
  ErrorCode,
  LiveScreenState,
  ProviderHealth,
  Session,
  Settings,
  SourceAvailability,
  TranscriptEvent,
  TranscriptSegment,
  TranscriptStatus,
} from "../../shared/types";
import { api, errMsg, newId } from "./api";

export function useAppEvent(fn: (e: AppEvent) => void) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  useEffect(() => api.onApp((e) => ref.current(e)), []);
}

export function useSettings(): [Settings | null, (patch: unknown) => Promise<void>, string | null] {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.getSettings().then(setSettings);
    return api.onApp((e) => {
      if (e.type === "settings") setSettings(e.settings);
    });
  }, []);
  const update = useCallback(async (patch: unknown) => {
    try {
      setSettings(await api.updateSettings(patch));
      setError(null);
    } catch (err) {
      setError(errMsg(err));
      throw err;
    }
  }, []);
  return [settings, update, error];
}

/** The active workspace session; updates when the user switches or edits sessions. */
export function useActiveSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null);
  const load = useCallback(() => void api.activeSession().then(setSession), []);
  useEffect(load, [load]);
  useAppEvent((e) => {
    if (e.type === "session-switched" || e.type === "sessions-changed") load();
  });
  return session;
}

export function useContextItems(): ContextItemSummary[] {
  const [items, setItems] = useState<ContextItemSummary[]>([]);
  const sessionRef = useRef<string | null>(null);
  useEffect(() => {
    void api.activeSession().then((s) => {
      sessionRef.current = s.id;
      void api.listContext().then(setItems);
    });
  }, []);
  useAppEvent((e) => {
    if (e.type === "session-switched") {
      sessionRef.current = e.sessionId;
      void api.listContext().then(setItems);
    }
    // Only accept updates for the session this window is showing.
    if (e.type === "context" && e.sessionId === sessionRef.current) setItems(e.items);
  });
  // Re-render periodically so expiry countdowns stay current and expired items drop out.
  const now = useNow(30_000);
  return items.filter((i) => i.expiresAt === null || i.expiresAt > now);
}

/** Current time, refreshed on an interval (keeps render pure). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useProviderHealth(): ProviderHealth | null {
  const [h, setH] = useState<ProviderHealth | null>(null);
  useEffect(() => void api.providerHealth().then(setH), []);
  useAppEvent((e) => {
    if (e.type === "provider-health") setH(e.health);
    if (e.type === "settings") void api.providerHealth().then(setH);
  });
  return h;
}

export function useLiveScreen(): LiveScreenState | null {
  const [s, setS] = useState<LiveScreenState | null>(null);
  useEffect(() => void api.liveScreenState().then(setS), []);
  useAppEvent((e) => e.type === "live-screen" && setS(e.state));
  return s;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: ContextReference[];
  status: "done" | "streaming" | "error" | "cancelled";
  error?: { message: string; code: ErrorCode; retryable: boolean };
  meta?: { model?: string; isMock?: boolean; costUsd?: number; ttftMs?: number | null; totalMs?: number; fallback?: string | null; style?: AnswerStyle; stopReason?: string };
  warnings?: string[];
  availability?: SourceAvailability;
  /** Origin label shown on the user turn (e.g. "Behavioral question", "Debug"). */
  label?: string;
  retryNote?: string;
}

function fromStored(m: ChatMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    references: m.references,
    label: m.meta.origin?.label,
    status: m.meta.cancelled ? "cancelled" : "done",
    meta: { model: m.meta.model, isMock: m.meta.isMock, costUsd: m.meta.estimatedCostUsd, ttftMs: m.meta.ttftMs, totalMs: m.meta.totalMs, style: m.meta.style, stopReason: m.meta.stopReason },
  };
}

/**
 * Chat state machine bound to streaming IPC events. Events are matched by request id, so deltas
 * from one question can never be appended to another; a session switch resets the thread.
 */
export function useChat(settings: Settings | null, chatOpts?: { adoptSuggestions?: boolean; restore?: boolean }) {
  const adoptSuggestions = !!chatOpts?.adoptSuggestions;
  /** Mode workspaces start with a fresh thread; the general assistant restores the last one. */
  const restoreEnabled = chatOpts?.restore ?? true;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const reqRef = useRef<string | null>(null);
  const placeholder = useRef<string | null>(null);

  const reset = useCallback(() => {
    reqRef.current = null;
    placeholder.current = null;
    setActiveRequest(null);
    setConversationId(null);
    setMessages([]);
  }, []);

  useAppEvent((e) => {
    if (e.type === "session-switched") reset();
  });

  useEffect(
    () =>
      api.onChat((e) => {
        // A suggestion started by the main process (interview copilot): adopt it as the active
        // request so it streams into this thread like a typed question. Only when idle, so a
        // user's own question is never displaced.
        if (e.type === "suggestion" && adoptSuggestions) {
          if (reqRef.current && reqRef.current.startsWith("iq-")) {
            // Older suggestion superseded: it will emit "cancelled" for its own id.
          } else if (reqRef.current) return;
          const pid = `pending-${e.requestId}`;
          reqRef.current = e.requestId;
          placeholder.current = pid;
          setActiveRequest(e.requestId);
          setMessages((prev) => [
            ...prev.filter((m) => !(m.status === "streaming" && m.id.startsWith("pending-iq-"))),
            { id: `u-${e.requestId}`, role: "user", content: e.question.text, references: [], status: "done", label: `${e.question.categoryLabel} question` },
            { id: pid, role: "assistant", content: "", references: [], status: "streaming", meta: { style: "suggest" } },
          ]);
          return;
        }
        if (e.requestId !== reqRef.current) return;
        const pid = placeholder.current;
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.findIndex((m) => m.id === pid);
          if (idx < 0) return prev;
          const cur = { ...next[idx]! };
          switch (e.type) {
            case "start":
              setConversationId(e.conversationId);
              cur.references = e.references;
              cur.warnings = e.warnings;
              cur.availability = e.availability;
              cur.meta = { model: e.provider.model, isMock: e.provider.isMock };
              // Reconcile the optimistic user message id with the stored one.
              if (idx > 0 && next[idx - 1]!.role === "user") next[idx - 1] = { ...next[idx - 1]!, id: e.userMessageId };
              break;
            case "delta":
              cur.content += e.text;
              cur.retryNote = undefined;
              break;
            case "retrying":
              cur.content = "";
              cur.retryNote = `${e.reason} Retrying (attempt ${e.attempt + 1})…`;
              break;
            case "done":
              cur.id = e.messageId;
              cur.status = "done";
              cur.retryNote = undefined;
              cur.references = cur.references.filter((r) => e.citedLabels.includes(r.label));
              cur.meta = { ...cur.meta, costUsd: e.usage.estimatedCostUsd, ttftMs: e.ttftMs, totalMs: e.totalMs, fallback: e.servedByFallback, stopReason: e.stopReason };
              break;
            case "error":
              if (e.conversationId) setConversationId(e.conversationId);
              cur.status = "error";
              cur.retryNote = undefined;
              cur.error = { message: e.message, code: e.code, retryable: e.retryable };
              break;
            case "cancelled":
              cur.status = "cancelled";
              if (e.partialMessageId) cur.id = e.partialMessageId;
              break;
          }
          next[idx] = cur;
          return next;
        });
        if (e.type === "done" || e.type === "error" || e.type === "cancelled") {
          reqRef.current = null;
          placeholder.current = null;
          setActiveRequest(null);
        }
      }),
    [adoptSuggestions],
  );

  const send = useCallback(
    async (text: string, opts: { includeLiveTranscript: boolean; retryOf?: string; style?: AnswerStyle; mode?: Parameters<typeof api.chatSend>[0]["mode"]; label?: string }) => {
      if (!settings || reqRef.current) return;
      const requestId = newId();
      const pid = `pending-${requestId}`;
      reqRef.current = requestId;
      placeholder.current = pid;
      setActiveRequest(requestId);
      setMessages((prev) => {
        const base = opts.retryOf ? prev.filter((m) => m.id !== opts.retryOf) : prev;
        const user: UiMessage[] = opts.retryOf ? [] : [{ id: `u-${requestId}`, role: "user", content: text, references: [], status: "done", label: opts.label }];
        return [...base, ...user, { id: pid, role: "assistant", content: "", references: [], status: "streaming", meta: { style: opts.style ?? settings.assistant.style } }];
      });
      try {
        await api.chatSend({
          requestId,
          conversationId,
          text,
          style: opts.style ?? settings.assistant.style,
          tone: settings.assistant.tone,
          includeLiveTranscript: opts.includeLiveTranscript,
          retryOfMessageId: opts.retryOf,
          mode: opts.mode,
        });
      } catch (err) {
        setMessages((prev) => prev.map((m) => (m.id === pid ? { ...m, status: "error", error: { message: errMsg(err), code: "unknown", retryable: false } } : m)));
        reqRef.current = null;
        setActiveRequest(null);
      }
    },
    [settings, conversationId],
  );

  const cancel = useCallback(() => {
    if (reqRef.current) void api.chatCancel(reqRef.current);
  }, []);

  const retry = useCallback(
    (assistantId: string, includeLiveTranscript: boolean) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      const msg = messages[idx];
      if (!msg) return;
      // Errors before anything was stored: resend the preceding user text as a new turn.
      if (msg.status === "error" && msg.id.startsWith("pending-")) {
        const user = messages.slice(0, idx).findLast((m) => m.role === "user");
        setMessages((prev) => prev.filter((m) => m.id !== assistantId && m.id !== user?.id));
        if (user) void send(user.content, { includeLiveTranscript, style: msg.meta?.style });
        return;
      }
      void send("", { includeLiveTranscript, retryOf: assistantId, style: msg.meta?.style });
    },
    [messages, send],
  );

  const load = useCallback(async (id: string | null) => {
    if (reqRef.current) return; // never swap threads under a streaming answer
    setConversationId(id);
    setMessages(id ? (await api.getMessages(id)).map(fromStored) : []);
    void api.setOpenConversation(id);
  }, []);

  // Restore the conversation that was open in this session (after restart, reload or switch).
  const restore = useCallback(async () => {
    const id = await api.openConversation().catch(() => null);
    if (!id || reqRef.current) return;
    const msgs = await api.getMessages(id).catch(() => null);
    if (!msgs || reqRef.current) return;
    setConversationId(id);
    setMessages(msgs.map(fromStored));
  }, []);
  useEffect(() => {
    if (restoreEnabled) void restore();
  }, [restore, restoreEnabled]);
  useAppEvent((e) => {
    if (e.type === "session-switched" && restoreEnabled) void restore();
  });

  return { conversationId, messages, busy: activeRequest !== null, send, cancel, retry, load };
}

export interface LiveTranscript extends Omit<TranscriptState, "segments"> {
  detail: string | null;
  action: "retry" | "settings" | "microphone" | "permissions" | null;
  segments: TranscriptSegment[];
  /** Latest partial result per channel ("mic" / "system" / "mono"). */
  interim: { text: string; speaker: string | null } | null;
  interims: Record<string, { text: string; speaker: string | null }>;
  audio: AudioInputState | null;
  /** Recording is running in a different session than the one shown. */
  elsewhere: boolean;
}

const EMPTY: LiveTranscript = {
  sessionId: null,
  workspaceSessionId: null,
  status: "idle",
  title: null,
  persisted: true,
  channels: 1,
  detail: null,
  action: null,
  segments: [],
  interim: null,
  interims: {},
  audio: null,
  elsewhere: false,
};

export function useLiveTranscript(): LiveTranscript {
  const [state, setState] = useState<LiveTranscript>(EMPTY);
  const activeSession = useRef<string | null>(null);
  const load = useCallback(async () => {
    const [s, session] = await Promise.all([api.transcriptState(), api.activeSession()]);
    activeSession.current = session.id;
    setState((p) => ({
      ...p,
      ...s,
      detail: null,
      action: null,
      interim: null,
      elsewhere: !!s.workspaceSessionId && s.workspaceSessionId !== session.id && s.status !== "idle",
    }));
  }, []);
  useEffect(() => void load(), [load]);
  useAppEvent((e) => e.type === "session-switched" && void load());
  useEffect(
    () =>
      api.onTranscript((e: TranscriptEvent) => {
        setState((p) => {
          if (e.type === "audio") return { ...p, audio: e.state };
          if (e.type === "status") {
            const mine = e.workspaceSessionId === activeSession.current;
            if (!mine) {
              const running = ["recording", "paused", "reconnecting", "connecting"].includes(e.status);
              return { ...p, elsewhere: running, status: running ? e.status : "idle", workspaceSessionId: e.workspaceSessionId };
            }
            const fresh = e.sessionId !== p.sessionId;
            return {
              ...p,
              elsewhere: false,
              sessionId: e.sessionId,
              workspaceSessionId: e.workspaceSessionId,
              status: e.status,
              detail: e.detail ?? null,
              action: e.action ?? null,
              segments: fresh ? [] : p.segments,
              interim: e.status === "stopped" || e.status === "error" ? null : p.interim,
              interims: e.status === "stopped" || e.status === "error" || fresh ? {} : p.interims,
              audio: e.status === "stopped" || e.status === "error" ? null : p.audio,
            };
          }
          if (p.elsewhere) return p;
          if (e.type === "interim") {
            if (e.sessionId !== p.sessionId) return p;
            const interims = { ...p.interims, [e.channel ?? "mono"]: { text: e.text, speaker: e.speaker } };
            return { ...p, interims, interim: Object.values(interims).at(-1) ?? null };
          }
          if (e.segment.sessionId !== p.sessionId) return p;
          // Guard against duplicate delivery of the same segment.
          if (p.segments.some((s) => s.id === e.segment.id)) return p;
          // A final only clears the partial for its own channel.
          const interims = { ...p.interims };
          delete interims[e.segment.channel ?? "mono"];
          const segments = [...p.segments, e.segment].sort((a, b) => a.startMs - b.startMs);
          return { ...p, interims, interim: Object.values(interims).at(-1) ?? null, segments };
        });
      }),
    [],
  );
  return state;
}

export const isRecordingStatus = (s: TranscriptStatus) => s === "recording" || s === "paused" || s === "reconnecting" || s === "connecting";
