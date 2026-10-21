import { useEffect, useRef, useState } from "react";
import { MODE_LABELS } from "../../shared/defaults";
import type { AssistantMode, Settings, Tone } from "../../shared/types";
import { api, errMsg } from "../lib/api";
import { useChat, useContextItems, type LiveTranscript } from "../lib/hooks";
import { ContextChips, Empty, MessageView, Segmented } from "../components/ui";

const STARTERS: Record<AssistantMode, string[]> = {
  general: ["Summarize what's on my screen", "Explain this in simple terms"],
  meeting: ["What did we just agree on?", "What should I say next?", "List open questions"],
  interview: ["Ask me a behavioural interview question", "Help me structure an answer with STAR"],
  technical: ["Explain this step by step", "What are the trade-offs here?"],
  coding: ["What's wrong with this code?", "Write a test for this function"],
};

export function AssistantScreen({ settings, update, live }: { settings: Settings; update: (p: unknown) => Promise<void>; live: LiveTranscript }) {
  const chat = useChat(settings);
  const items = useContextItems();
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveActive = live.status === "recording" || live.status === "paused" || live.status === "reconnecting";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.messages]);

  const submit = (q = text) => {
    if (!q.trim() || chat.busy) return;
    setText("");
    void chat.send(q.trim(), { includeLiveTranscript: liveActive });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const last = chat.messages.findLast((m) => m.role === "assistant");

  return (
    <>
      <header className="page-header">
        <h1>Assistant</h1>
        <select className="select" style={{ width: 190 }} aria-label="Mode" value={settings.assistant.mode} onChange={(e) => void update({ assistant: { mode: e.target.value } })}>
          {Object.entries(MODE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <Segmented
          label="Answer length"
          value={settings.assistant.length}
          options={[
            { value: "short", label: "Short" },
            { value: "detailed", label: "Detailed" },
          ]}
          onChange={(v) => void update({ assistant: { length: v } })}
        />
        <select className="select" style={{ width: 130 }} aria-label="Tone" value={settings.assistant.tone} onChange={(e) => void update({ assistant: { tone: e.target.value as Tone } })}>
          <option value="neutral">Neutral</option>
          <option value="friendly">Friendly</option>
          <option value="formal">Formal</option>
          <option value="confident">Confident</option>
        </select>
        <span className="spacer" />
        {liveActive && <span className="badge danger">● Live transcript included</span>}
        <button className="btn" onClick={() => void chat.load(null)}>
          New chat
        </button>
      </header>
      <div className="page" ref={scrollRef}>
        {chat.messages.length ? (
          <div className="thread" style={{ maxWidth: 820, margin: "0 auto" }}>
            {chat.messages.map((m) => (
              <MessageView key={m.id} m={m} onCopy={(t) => void api.copyText(t)} onRetry={m === last && !chat.busy ? () => chat.retry(m.id, liveActive) : undefined} />
            ))}
          </div>
        ) : (
          <Empty title={MODE_LABELS[settings.assistant.mode]}>
            Add context below — a note, a document, your clipboard or a screenshot — then ask a question. Answers cite the sources they used.
            <span className="row" style={{ justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
              {STARTERS[settings.assistant.mode].map((s) => (
                <button key={s} className="btn sm" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </span>
          </Empty>
        )}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: "12px 24px" }}>
        <div className="col" style={{ maxWidth: 820, margin: "0 auto" }}>
          {error && <div className="alert error small">{error}</div>}
          {note && (
            <div className="card col">
              <input className="input" placeholder="Note title (e.g. Job description)" value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} />
              <textarea className="textarea" placeholder="Paste reference text…" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
              <div className="row">
                <button
                  className="btn primary sm"
                  disabled={!note.text.trim()}
                  onClick={() =>
                    void run(async () => {
                      await api.addNote(note.title, note.text);
                      setNote(null);
                    })
                  }
                >
                  Add to context
                </button>
                <button className="btn ghost sm" onClick={() => setNote(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <ContextChips items={items} />
          <textarea
            className="textarea"
            style={{ minHeight: 60 }}
            aria-label="Message"
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && chat.busy) chat.cancel();
            }}
          />
          <div className="row">
            <button className="btn sm" onClick={() => setNote({ title: "", text: "" })}>
              ✎ Note
            </button>
            <button className="btn sm" onClick={() => void run(() => api.addDocuments())}>
              ▤ Document
            </button>
            <button className="btn sm" onClick={() => void run(() => api.addClipboard())}>
              ⧉ Clipboard
            </button>
            <button className="btn sm" onClick={() => (location.hash = "/main/capture")} disabled={!settings.consent.screen} title={settings.consent.screen ? "" : "Enable screen context in Permissions"}>
              ▣ Screen / region
            </button>
            <span className="spacer" />
            {chat.busy ? (
              <button className="btn danger" onClick={chat.cancel}>
                ■ Stop
              </button>
            ) : (
              <button className="btn primary" onClick={() => submit()} disabled={!text.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
