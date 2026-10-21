import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MODE_LABELS } from "../shared/defaults";
import type { AssistantMode } from "../shared/types";
import { api, errMsg, prettyAccelerator } from "./lib/api";
import { AudioCapture } from "./lib/audio";
import { useAppEvent, useChat, useContextItems, useLiveTranscript, useSettings } from "./lib/hooks";
import { ContextChips, MessageView, Toasts, useTheme } from "./components/ui";

const audio = new AudioCapture();

export function Overlay() {
  const [settings, update] = useSettings();
  useTheme(settings?.theme);
  const chat = useChat(settings);
  const items = useContextItems();
  const live = useLiveTranscript();
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveActive = live.status === "recording" || live.status === "paused" || live.status === "reconnecting" || live.status === "connecting";
  const [useLive, setUseLive] = useState(true);

  useEffect(() => {
    document.body.classList.add("overlay-body");
  }, []);

  useAppEvent((e) => {
    if (e.type === "focus-input") inputRef.current?.focus();
    if (e.type === "audio-command") {
      if (e.command === "start") void audio.start(e.micDeviceId, e.systemAudio);
      else void audio.stop();
    }
  });

  useEffect(() => {
    if (live.status === "stopped" || live.status === "error") void audio.stop();
  }, [live.status]);

  // Keep the newest tokens in view while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const hasThread = chat.messages.length > 0;
  useEffect(() => {
    void api.setOverlaySize(window.innerWidth, hasThread || expanded ? 520 : 168);
  }, [hasThread, expanded]);

  const submit = () => {
    const q = text.trim();
    if (!q || chat.busy) return;
    setText("");
    void chat.send(q, { includeLiveTranscript: liveActive && useLive });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // Global keyboard handling for the panel.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (chat.busy) chat.cancel();
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
        setExpanded((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chat]);

  const copy = (t: string) => {
    void api.copyText(t).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

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

  return (
    <div className="overlay" role="dialog" aria-label="Lumen assistant">
      <div className="overlay-bar">
        <span className="brand">
          <span className="brand-mark" aria-hidden /> Lumen
        </span>
        <select
          className="mini-select"
          aria-label="Assistant mode"
          value={settings.assistant.mode}
          onChange={(e) => void update({ assistant: { mode: e.target.value as AssistantMode } })}
        >
          {Object.entries(MODE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          className="btn ghost sm"
          aria-pressed={settings.assistant.length === "detailed"}
          title="Toggle short / detailed answers"
          onClick={() => void update({ assistant: { length: settings.assistant.length === "short" ? "detailed" : "short" } })}
        >
          {settings.assistant.length === "short" ? "Short" : "Detailed"}
        </button>
        {settings.provider.kind === "mock" && <span className="badge warning">Dev mode</span>}
        {liveActive && (
          <span className="rec-pill" title={live.detail ?? undefined}>
            <span className={`dot ${live.status === "recording" ? "rec" : "warn"}`} />
            {live.status === "recording" ? "REC" : live.status === "paused" ? "Paused" : "Reconnecting"}
            <button className="btn ghost sm no-drag" style={{ color: "inherit", height: 18 }} onClick={() => void api.transcriptStop()} aria-label="Stop recording">
              Stop
            </button>
          </span>
        )}
        <span className="spacer" />
        {copied && <span className="small muted">Copied</span>}
        <button className="btn ghost sm icon" title="New conversation (⌘N)" aria-label="New conversation" onClick={() => void chat.load(null)}>
          ＋
        </button>
        <button className="btn ghost sm icon" title="Open full window" aria-label="Open full window" onClick={() => void api.openMain(chat.conversationId ? "/main/history" : "/main/assistant")}>
          ⤢
        </button>
        <button className="btn ghost sm icon" title="Hide (Esc)" aria-label="Hide assistant" onClick={() => void api.overlay("hide")}>
          ✕
        </button>
      </div>

      {(hasThread || expanded) && (
        <div className="overlay-body-scroll" ref={scrollRef}>
          {hasThread ? (
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
              <h3>Ask anything</h3>
              <p>
                Attach your screen, clipboard or a note, or start a live transcript — Lumen only sees what you add. Press{" "}
                <kbd>{prettyAccelerator(settings.shortcuts.askAboutScreen)}</kbd> to capture the screen under your cursor.
              </p>
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
        <div className="row">
          <button
            className="btn ghost sm"
            disabled={!settings.consent.screen}
            title={settings.consent.screen ? "Capture the screen under the cursor" : "Enable screen context in Permissions"}
            onClick={() => void run(() => api.quickCapture())}
          >
            ▣ Screen
          </button>
          <button className="btn ghost sm" title="Pick a window or region" onClick={() => void api.openMain("/main/capture")}>
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
            <button className="btn danger sm" onClick={chat.cancel} title="Stop (Esc)">
              ■ Stop
            </button>
          ) : (
            <button className="btn primary sm" onClick={submit} disabled={!text.trim()}>
              Ask ↵
            </button>
          )}
        </div>
      </div>
      <Toasts />
    </div>
  );
}
