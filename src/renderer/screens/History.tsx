import { useEffect, useState } from "react";
import { MODE_LABELS } from "../../shared/defaults";
import type { ChatMessage, Conversation, SearchHit } from "../../shared/types";
import { api, formatTime } from "../lib/api";
import { useAppEvent } from "../lib/hooks";
import { Markdown } from "../lib/markdown";
import { Empty, Segmented } from "../components/ui";

/** Render FTS snippets («match») safely as React nodes. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <span>
      {parts.map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function HistoryScreen() {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [scope, setScope] = useState<"session" | "all">("session");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void api.listConversations().then(setConversations);
  useEffect(refresh, []);
  useAppEvent((e) => {
    if (e.type === "history-changed") refresh();
    if (e.type === "session-switched") {
      setSelected(null);
      setMessages([]);
      refresh();
    }
  });
  useEffect(() => {
    if (selected) void api.getMessages(selected).then(setMessages);
  }, [selected]);
  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => void api.search(query, scope).then(setHits), 180);
    return () => clearTimeout(t);
  }, [query, scope]);

  const conv = conversations?.find((c) => c.id === selected);

  return (
    <>
      <header className="page-header">
        <h1>History</h1>
        <input className="input" style={{ maxWidth: 360 }} type="search" placeholder="Search conversations and transcripts…" aria-label="Search history" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented
          label="Search scope"
          value={scope}
          options={[
            { value: "session", label: "This session" },
            { value: "all", label: "All sessions" },
          ]}
          onChange={setScope}
        />
      </header>
      {notice && (
        <div className="alert info small" style={{ margin: "8px 24px 0" }}>
          {notice}
          <button className="btn ghost sm" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="list" aria-label="Conversations">
          {conversations === null ? (
            <div className="row small muted" style={{ padding: 14 }}>
              <span className="spinner" /> Loading…
            </div>
          ) : hits ? (
            hits.length === 0 ? (
              <div className="small muted" style={{ padding: 14 }}>No matches for “{query}”.</div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.itemId}
                  className="list-item"
                  onClick={() => {
                    // Opening a result from another session requires switching to it first.
                    if (scope === "all" && conversations && !conversations.some((c) => c.id === h.parentId) && h.kind === "message") {
                      if (confirm(`“${h.parentTitle}” is in another session. Switch to that session to open it?`)) {
                        void api.switchSession(h.sessionId).then(() => {
                          setScope("session");
                          setTimeout(() => setSelected(h.parentId), 150);
                        });
                      }
                      return;
                    }
                    if (h.kind === "message") setSelected(h.parentId);
                    else if (scope === "all") {
                      void api.switchSession(h.sessionId).then(() => (location.hash = "/main/transcript"));
                      setNotice("Switched to the transcript's session.");
                    } else location.hash = "/main/transcript";
                  }}
                >
                  <div className="title">
                    <span className="badge">{h.kind === "message" ? "Chat" : "Transcript"}</span> {h.parentTitle}
                  </div>
                  <div className="small muted">
                    <Snippet text={h.snippet} />
                  </div>
                </button>
              ))
            )
          ) : conversations.length === 0 ? (
            <div className="small muted" style={{ padding: 14 }}>No conversations in this session yet.</div>
          ) : (
            conversations.map((c) => (
              <button key={c.id} className="list-item" aria-selected={selected === c.id} onClick={() => setSelected(c.id)}>
                <div className="title">{c.title}</div>
                <div className="small faint">
                  {MODE_LABELS[c.mode]} · {c.messageCount} messages · {formatTime(c.updatedAt)}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="detail">
          {!conv ? (
            <Empty title="Conversation history">Select a conversation, or search across every question, answer and transcript. History is stored locally on this device.</Empty>
          ) : (
            <div className="page">
              <div className="row" style={{ marginBottom: 16 }}>
                {renaming !== null ? (
                  <input
                    className="input"
                    autoFocus
                    value={renaming}
                    onChange={(e) => setRenaming(e.target.value)}
                    onBlur={() => {
                      void api.renameConversation(conv.id, renaming).then(refresh);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <h2 style={{ margin: 0, fontSize: 16 }}>{conv.title}</h2>
                )}
                <span className="spacer" />
                <button className="btn sm" onClick={() => setRenaming(conv.title)}>
                  Rename
                </button>
                <button
                  className="btn sm"
                  onClick={() => void api.copyText(messages.map((m) => `${m.role === "user" ? "You" : "Lumen"}: ${m.content}`).join("\n\n"))}
                >
                  Copy all
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    if (confirm("Delete this conversation permanently?"))
                      void api.deleteConversation(conv.id).then(() => {
                        setSelected(null);
                        refresh();
                      });
                  }}
                >
                  Delete
                </button>
              </div>
              <div className="thread">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="msg user">
                      <div className="bubble">{m.content}</div>
                      {m.meta.attachments?.length ? <div className="small faint" style={{ alignSelf: "flex-end" }}>with {m.meta.attachments.length} context source(s)</div> : null}
                    </div>
                  ) : (
                    <div key={m.id} className="msg assistant">
                      <Markdown text={m.content} refs={m.references} onCopy={(t) => void api.copyText(t)} onLink={(u) => void api.openExternal(u)} />
                      <div className="msg-meta">
                        {m.meta.isMock && <span className="badge warning">Mock</span>}
                        {m.meta.cancelled && <span className="badge warning">Stopped</span>}
                        <span>{m.meta.model}</span>
                        <span>{formatTime(m.createdAt)}</span>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
