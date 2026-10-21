import { useEffect, useRef, useState } from "react";
import { MODE_LABELS, STYLE_LABELS } from "../../shared/defaults";
import type { AnswerStyle, AssistantMode, Conversation, Settings, Tone } from "../../shared/types";
import { api, formatTime } from "../lib/api";
import { isRecordingStatus, useActiveSession, useAppEvent, useChat, useContextItems, type LiveTranscript } from "../lib/hooks";
import { ContextChips, Empty, MessageView, useAction } from "../components/ui";

const STARTERS: Record<AssistantMode, string[]> = {
  general: ["Summarize what's on my screen", "Explain this in simple terms"],
  meeting: ["What did we just agree on?", "What should I say next?", "List open questions"],
  interview: ["Ask me a behavioural interview question", "Help me structure an answer with STAR"],
  technical: ["Explain this step by step", "What are the trade-offs here?"],
  coding: ["What's wrong with this code?", "Write a test for this function"],
};

export function AssistantScreen({ settings, update, live }: { settings: Settings; update: (p: unknown) => Promise<void>; live: LiveTranscript }) {
  const session = useActiveSession();
  const chat = useChat(settings);
  const items = useContextItems();
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { run, error, setError } = useAction();
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveActive = isRecordingStatus(live.status) && !live.elsewhere;
  const [useLive, setUseLive] = useState(true);

  const loadConversations = () => void api.listConversations().then(setConversations);
  useEffect(loadConversations, []);
  useAppEvent((e) => (e.type === "history-changed" || e.type === "session-switched") && loadConversations());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.messages]);

  const submit = (q = text, style?: AnswerStyle) => {
    if (!q.trim() || chat.busy) return;
    setText("");
    void chat.send(q.trim(), { includeLiveTranscript: liveActive && useLive, style });
  };
  const last = chat.messages.findLast((m) => m.role === "assistant");
  const effectiveStyle = session?.ai.style ?? settings.assistant.style;

  return (
    <>
      <header className="page-header">
        <h1>{session?.title ?? "Assistant"}</h1>
        {session && <span className="badge">{MODE_LABELS[session.type]}</span>}
        <span className="spacer" />
        <select className="select" style={{ width: 200 }} aria-label="Answer style" value={effectiveStyle} disabled={!!session?.ai.style} title={session?.ai.style ? "Set by this session's AI overrides" : undefined} onChange={(e) => void update({ assistant: { style: e.target.value } })}>
          {Object.entries(STYLE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 130 }} aria-label="Tone" value={settings.assistant.tone} onChange={(e) => void update({ assistant: { tone: e.target.value as Tone } })}>
          <option value="neutral">Neutral</option>
          <option value="friendly">Friendly</option>
          <option value="formal">Formal</option>
          <option value="confident">Confident</option>
        </select>
        {liveActive && (
          <label className="row small" title="Include the live transcript as context">
            <input type="checkbox" checked={useLive} onChange={(e) => setUseLive(e.target.checked)} /> Live transcript
          </label>
        )}
        <button className="btn" onClick={() => void chat.load(null)}>
          New chat
        </button>
      </header>
      <div className="split" style={{ flex: 1, minHeight: 0, gridTemplateColumns: "240px 1fr" }}>
        <div className="list" aria-label="Conversations in this session">
          {conversations.length === 0 ? (
            <div className="small muted" style={{ padding: 14 }}>
              No conversations in this session yet.
            </div>
          ) : (
            conversations.map((c) => (
              <button key={c.id} className="list-item" aria-selected={chat.conversationId === c.id} disabled={chat.busy} onClick={() => void chat.load(c.id)}>
                <div className="title">{c.title}</div>
                <div className="small faint">
                  {c.messageCount} messages · {formatTime(c.updatedAt)}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="detail">
          <div className="page" ref={scrollRef}>
            {chat.messages.length ? (
              <div className="thread" style={{ maxWidth: 820, margin: "0 auto" }}>
                {chat.messages.map((m) => (
                  <MessageView key={m.id} m={m} onCopy={(t) => void api.copyText(t)} onRetry={m === last && !chat.busy ? () => chat.retry(m.id, liveActive && useLive) : undefined} />
                ))}
              </div>
            ) : (
              <Empty title={session ? `${MODE_LABELS[session.type]} session` : "Assistant"}>
                Add context below — a note, a document, your clipboard or a screen capture — then ask. Answers cite the sources they used and say when something they need is missing.
                <span className="row" style={{ justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                  {STARTERS[session?.type ?? "general"].map((s) => (
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
              {error && (
                <div className="alert error small" role="alert">
                  {error}
                </div>
              )}
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
                      Add to session context
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
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn sm" onClick={() => setNote({ title: "", text: "" })}>
                  ✎ Note
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    void run(async () => {
                      const r = await api.addDocuments();
                      if (r.failed.length) setError(r.failed.map((f) => `${f.file}: ${f.reason}`).join("\n"));
                    })
                  }
                >
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
        </div>
      </div>
    </>
  );
}
