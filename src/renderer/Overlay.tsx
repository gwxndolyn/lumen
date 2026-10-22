import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { STYLE_LABELS } from "../shared/defaults";
import type { AnswerStyle, SessionSummary } from "../shared/types";
import { api, errMsg, prettyAccelerator } from "./lib/api";
import { AudioCapture } from "./lib/audio";
import { isRecordingStatus, useActiveSession, useAppEvent, useChat, useContextItems, useLiveScreen, useLiveTranscript, useProviderHealth, useSettings } from "./lib/hooks";
import { ContextChips, MessageView, ProviderStatus, RecordingControls, Toasts, useTheme } from "./components/ui";

const audio = new AudioCapture();
const QUICK_STYLES: AnswerStyle[] = ["quick", "detailed", "steps", "suggest", "technical", "meeting_summary", "follow_ups"];

export function Overlay() {
  const [settings, update] = useSettings();
  useTheme(settings?.theme);
  const session = useActiveSession();
  const chat = useChat(settings);
  const items = useContextItems();
  const live = useLiveTranscript();
  const liveScreen = useLiveScreen();
  const health = useProviderHealth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"compact" | "expanded" | "discreet">("compact");
  const [notice, setNotice] = useState<string | null>(null);
  // Set below once `assist` is defined; the app-event handler always calls the latest version.
  const assistRef = useRef<() => Promise<void>>(async () => undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [useLive, setUseLive] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const liveActive = isRecordingStatus(live.status) && !live.elsewhere;
  const pendingCaptures = items.some((i) => i.status === "pending");

  useEffect(() => {
    document.body.classList.add("overlay-body");
  }, []);

  const loadSessions = () => void api.listSessions().then(setSessions);
  useEffect(loadSessions, []);

  useAppEvent((e) => {
    if (e.type === "focus-input") inputRef.current?.focus();
    if (e.type === "overlay-mode") {
      setMode(e.mode);
      if (e.mode === "discreet") setTimeout(() => inputRef.current?.focus(), 0);
    }
    if (e.type === "assist-request") void assistRef.current();
    if (e.type === "scroll") {
      // Scroll Lumen's own response area — never the underlying application.
      const el = scrollRef.current;
      if (el) {
        const step = Math.max(80, Math.round(el.clientHeight * 0.8));
        el.scrollBy({ top: e.direction === "up" ? -step : step, behavior: "smooth" });
        pinnedToBottom.current = e.direction === "down" && el.scrollHeight - el.scrollTop - el.clientHeight - step < 40;
      }
    }
    if (e.type === "sessions-changed" || e.type === "session-switched") loadSessions();
    if (e.type === "audio-command") {
      if (e.command === "start") void audio.start(e.micDeviceId, e.systemAudio);
      else if (e.command === "system-off") audio.stopSystem();
      else void audio.stop();
    }
  });

  useEffect(() => {
    if ((live.status === "stopped" || live.status === "error" || live.status === "idle") && audio.active) void audio.stop();
  }, [live.status]);

  // Expand automatically for answers / previews; the user can collapse with ⌘E. Discreet mode
  // stays slim — its answers are read in the bar or by leaving discreet mode.
  const needsRoom = chat.messages.length > 0 || pendingCaptures;
  useEffect(() => {
    if (needsRoom && mode === "compact") void api.overlay("expand");
  }, [needsRoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⌘/Ctrl+Enter: submit typed text, otherwise ask the main process which authorized context is
   * available (capturing the screen if, and only if, screen context is enabled) and ask about it.
   */
  const assist = async () => {
    setNotice(null);
    if (chat.busy) return;
    if (text.trim()) return submit();
    try {
      const plan = await api.assistPrepare();
      if (plan.capture.error) setNotice(`Screen capture failed: ${plan.capture.error}`);
      if (!plan.prompt) {
        setNotice((n) => n ?? plan.missing);
        inputRef.current?.focus();
        return;
      }
      pinnedToBottom.current = true;
      void chat.send(plan.prompt, { includeLiveTranscript: liveActive && useLive, style: plan.style });
    } catch (err) {
      setError(errMsg(err));
    }
  };

  // Follow streaming output unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const submit = (style?: AnswerStyle) => {
    const q = text.trim() || (style && style !== "quick" ? STYLE_LABELS[style] : "");
    if (!q || chat.busy) return;
    setText("");
    pinnedToBottom.current = true;
    void chat.send(q, { includeLiveTranscript: liveActive && useLive, style });
  };

  useEffect(() => {
    assistRef.current = assist;
  });

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void assist();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "ArrowUp" && !text) {
      const lastUser = chat.messages.findLast((m) => m.role === "user");
      if (lastUser) {
        e.preventDefault();
        setText(lastUser.content);
      }
    }
  };

  const copy = (t: string) => {
    void api.copyText(t).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // Global keyboard handling for the panel.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (chat.busy) chat.cancel();
        else if (mode === "discreet") void api.overlay("discreet");
        else void api.overlay("hide");
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void chat.load(null);
        inputRef.current?.focus();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        chat.cancel();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void api.overlay(mode === "compact" ? "expand" : "compact");
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const last = chat.messages.findLast((m) => m.role === "assistant" && m.content);
        if (last) copy(last.content);
      } else if (e.altKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        const s = QUICK_STYLES[Number(e.key) - 1]!;
        void update({ assistant: { style: s } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  if (!settings) return null;
  const lastAssistant = chat.messages.findLast((m) => m.role === "assistant");
  const expanded = mode === "expanded";

  if (mode === "discreet") {
    // Minimal input bar: one line in, a short live preview of the latest answer out.
    const latest = chat.messages.findLast((m) => m.role === "assistant");
    const preview = latest?.status === "error" ? latest.error?.message : latest?.content.replace(/\s+/g, " ").slice(-160);
    return (
      <div className="overlay discreet" role="dialog" aria-label="Lumen discreet input">
        <div className="discreet-bar">
          <span className="mode-tag" title="Discreet input mode — Esc or ⌘/Ctrl+Shift+Enter to leave">Discreet</span>
          <input
            ref={inputRef as unknown as React.RefObject<HTMLInputElement>}
            className="discreet-input"
            aria-label="Ask Lumen (discreet input)"
            placeholder={chat.busy ? "Answering…" : "Ask quietly… ↵ to send"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) void assist();
                else submit();
              }
            }}
          />
          {chat.busy ? (
            <button className="btn danger sm" onClick={chat.cancel} aria-label="Stop generating">
              ■
            </button>
          ) : (
            <button className="btn ghost sm" onClick={() => void api.overlay("discreet")} title="Open the full panel" aria-label="Leave discreet mode">
              ⤢
            </button>
          )}
          <button className="btn ghost sm" onClick={() => void api.overlay("hide")} aria-label="Hide assistant">
            ✕
          </button>
        </div>
        {(preview || notice) && (
          <div className="discreet-preview" aria-live="polite">
            {notice ?? preview}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`overlay ${expanded ? "expanded" : "compact"}`} role="dialog" aria-label="Lumen assistant">
      <div className="overlay-bar">
        <span className="brand">
          <span className="brand-mark" aria-hidden /> Lumen
        </span>
        <select
          className="mini-select session-switcher"
          aria-label="Session"
          value={session?.id ?? ""}
          onChange={(e) => {
            if (e.target.value === "__new") void api.openMain("/main/sessions");
            else void run(() => api.switchSession(e.target.value));
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
          <option value="__new">＋ New / manage sessions…</option>
        </select>
        <ProviderStatus health={health} compact />
        <RecordingControls live={live} compact />
        {liveScreen?.active && (
          <span className="rec-pill" style={{ color: "var(--accent-strong)", background: "var(--accent-soft)" }} title={liveScreen.lastError ?? "Live screen context is on"}>
            ▣ {liveScreen.paused ? "Screen paused" : "Live screen"}
            <button className="btn ghost sm no-drag" aria-label="Stop live screen context" onClick={() => void run(() => api.liveScreen("stop"))}>
              ■
            </button>
          </span>
        )}
        <span className="spacer" />
        {copied && <span className="small muted">Copied</span>}
        <button className="btn ghost sm icon" title="New conversation (⌘N)" aria-label="New conversation" onClick={() => void chat.load(null)}>
          ＋
        </button>
        <button className="btn ghost sm icon" title={expanded ? "Compact (⌘E)" : "Expand (⌘E)"} aria-label={expanded ? "Compact" : "Expand"} onClick={() => void api.overlay(expanded ? "compact" : "expand")}>
          {expanded ? "▴" : "▾"}
        </button>
        <button className="btn ghost sm icon" title="Open full window" aria-label="Open full window" onClick={() => void api.openMain("/main/assistant")}>
          ⤢
        </button>
        <button className="btn ghost sm icon" title="Hide (Esc)" aria-label="Hide assistant" onClick={() => void api.overlay("hide")}>
          ✕
        </button>
      </div>

      {expanded && (
        <div
          className="overlay-body-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {chat.messages.length ? (
            <div className="thread">
              {chat.messages.map((m) => (
                <MessageView
                  key={m.id}
                  m={m}
                  onCopy={copy}
                  onRetry={m.role === "assistant" && m === lastAssistant && !chat.busy ? () => chat.retry(m.id, liveActive && useLive) : undefined}
                />
              ))}
            </div>
          ) : (
            <div className="empty">
              <h3>{session?.title ?? "Ask anything"}</h3>
              <p>
                Lumen only sees what you add to this session. Press <kbd>{prettyAccelerator(settings.shortcuts.askAboutScreen)}</kbd> to capture the screen under your cursor, or{" "}
                <kbd>{prettyAccelerator(settings.shortcuts.askAboutSelection)}</kbd> after copying text.
              </p>
              <div className="kbd-hints">
                <span>↵ send</span>
                <span>⌘↵ assist with current context</span>
                <span>⌘\\ show/hide</span>
                <span>⌘↑/↓ scroll</span>
                <span>⌘←/→ move</span>
                <span>⌘⇧↵ discreet</span>
                <span>Esc stop/hide</span>
                <span>⌘E expand</span>
                <span>⌥1–7 answer style</span>
                <span>⌘⇧C copy last answer</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="overlay-input">
        {error && (
          <div className="alert error small" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="alert info small" role="status">
            {notice}
            <button className="btn ghost sm" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        <ContextChips items={items} compact />
        <textarea
          ref={inputRef}
          rows={1}
          autoFocus
          aria-label="Ask Lumen"
          placeholder={liveActive ? "Ask about the conversation…" : "Ask about your screen, a document, or anything…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="style-chips" role="group" aria-label="Answer style">
          {QUICK_STYLES.map((s, i) => (
            <button
              key={s}
              aria-pressed={settings.assistant.style === s}
              title={`${STYLE_LABELS[s]} (⌥${i + 1})${text.trim() ? "" : " — click again to ask"}`}
              onClick={() => {
                if (settings.assistant.style === s && !text.trim() && s !== "quick") submit(s);
                else void update({ assistant: { style: s } });
              }}
            >
              {STYLE_LABELS[s].replace(" explanation", "").replace("Step-by-step", "Steps")}
            </button>
          ))}
        </div>
        <div className="row">
          <button
            className="btn ghost sm"
            disabled={!settings.consent.screen}
            title={settings.consent.screen ? "Capture the screen under the cursor" : "Enable screen context in Permissions"}
            onClick={() => void run(() => api.quickCapture())}
          >
            ▣ Screen
          </button>
          <button
            className="btn ghost sm"
            disabled={!settings.consent.screen}
            title={settings.consent.screen ? "Pick a window or region" : "Enable screen context in Permissions"}
            onClick={() => void api.openMain("/main/capture")}
          >
            ⬚ Region
          </button>
          <button className="btn ghost sm" title="Add clipboard text as context" onClick={() => void run(() => api.addClipboard())}>
            ⧉ Clipboard
          </button>
          {liveActive && (
            <label className="row small muted no-drag" title="Include the live transcript as context">
              <input type="checkbox" checked={useLive} onChange={(e) => setUseLive(e.target.checked)} /> Transcript
            </label>
          )}
          <span className="spacer" />
          {chat.busy ? (
            <button className="btn danger sm" onClick={chat.cancel} title="Stop generating (Esc)">
              ■ Stop
            </button>
          ) : (
            <button className="btn primary sm" onClick={() => submit()} disabled={!text.trim()}>
              Ask ↵
            </button>
          )}
        </div>
      </div>
      <Toasts />
    </div>
  );
}
