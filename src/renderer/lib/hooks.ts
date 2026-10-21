import { useCallback, useEffect, useRef, useState } from "react";
import type { AppEvent } from "../../shared/api";
import type {
  ChatMessage,
  ContextItemSummary,
  ContextReference,
  ErrorCode,
  Settings,
  TranscriptEvent,
  TranscriptSegment,
  TranscriptStatus,
} from "../../shared/types";
import { api, errMsg, newId } from "./api";

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

export function useContextItems(): ContextItemSummary[] {
  const [items, setItems] = useState<ContextItemSummary[]>([]);
  useEffect(() => {
    void api.listContext().then(setItems);
    return api.onApp((e) => {
      if (e.type === "context") setItems(e.items);
    });
  }, []);
  return items;
}

export function useAppEvent(fn: (e: AppEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => api.onApp((e) => ref.current(e)), []);
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: ContextReference[];
  status: "done" | "streaming" | "error" | "cancelled";
  error?: { message: string; code: ErrorCode; retryable: boolean };
  meta?: { model?: string; isMock?: boolean; costUsd?: number; ttftMs?: number | null; totalMs?: number; fallback?: string | null };
  warnings?: string[];
  retryNote?: string;
}

function fromStored(m: ChatMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    references: m.references,
    status: m.meta.cancelled ? "cancelled" : "done",
    meta: { model: m.meta.model, isMock: m.meta.isMock, costUsd: m.meta.estimatedCostUsd },
  };
}

/** Chat state machine bound to streaming IPC events. */
export function useChat(settings: Settings | null) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const reqRef = useRef<string | null>(null);
  const placeholder = useRef<string | null>(null);

  useEffect(
    () =>
      api.onChat((e) => {
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
              cur.meta = { ...cur.meta, costUsd: e.usage.estimatedCostUsd, ttftMs: e.ttftMs, totalMs: e.totalMs, fallback: e.servedByFallback };
              break;
            case "error":
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
    [],
  );

  const send = useCallback(
    async (text: string, opts: { includeLiveTranscript: boolean; retryOf?: string }) => {
      if (!settings || reqRef.current) return;
      const requestId = newId();
      const pid = `pending-${requestId}`;
      reqRef.current = requestId;
      placeholder.current = pid;
      setActiveRequest(requestId);
      setMessages((prev) => {
        const base = opts.retryOf ? prev.filter((m) => m.id !== opts.retryOf) : prev;
        const user: UiMessage[] = opts.retryOf
          ? []
          : [{ id: `u-${requestId}`, role: "user", content: text, references: [], status: "done" }];
        return [...base, ...user, { id: pid, role: "assistant", content: "", references: [], status: "streaming" }];
      });
      try {
        await api.chatSend({
          requestId,
          conversationId,
          text,
          mode: settings.assistant.mode,
          length: settings.assistant.length,
          tone: settings.assistant.tone,
          includeLiveTranscript: opts.includeLiveTranscript,
          retryOfMessageId: opts.retryOf,
        });
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) => (m.id === pid ? { ...m, status: "error", error: { message: errMsg(err), code: "unknown", retryable: false } } : m)),
        );
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
        if (user) void send(user.content, { includeLiveTranscript });
        return;
      }
      void send("", { includeLiveTranscript, retryOf: assistantId });
    },
    [messages, send],
  );

  const load = useCallback(async (id: string | null) => {
    setConversationId(id);
    setMessages(id ? (await api.getMessages(id)).map(fromStored) : []);
  }, []);

  return { conversationId, messages, busy: activeRequest !== null, send, cancel, retry, load };
}

export interface LiveTranscript {
  sessionId: string | null;
  status: TranscriptStatus;
  title: string | null;
  detail: string | null;
  segments: TranscriptSegment[];
  interim: { text: string; speaker: string | null } | null;
}

export function useLiveTranscript(): LiveTranscript {
  const [state, setState] = useState<LiveTranscript>({ sessionId: null, status: "idle", title: null, detail: null, segments: [], interim: null });
  useEffect(() => {
    void api.transcriptState().then(async (s) => {
      const segments = s.sessionId ? await api.getSegments(s.sessionId) : [];
      setState((p) => ({ ...p, sessionId: s.sessionId, status: s.status as TranscriptStatus, title: s.title, segments }));
    });
    return api.onTranscript((e: TranscriptEvent) => {
      setState((p) => {
        if (e.type === "status") {
          const fresh = e.sessionId !== p.sessionId;
          return {
            ...p,
            sessionId: e.sessionId,
            status: e.status,
            detail: e.detail ?? null,
            segments: fresh ? [] : p.segments,
            interim: e.status === "stopped" ? null : p.interim,
          };
        }
        if (e.type === "interim") return { ...p, interim: { text: e.text, speaker: e.speaker } };
        return { ...p, interim: null, segments: [...p.segments, e.segment] };
      });
    });
  }, []);
  return state;
}
