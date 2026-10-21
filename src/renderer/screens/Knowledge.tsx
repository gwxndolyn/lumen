import { useEffect, useState } from "react";
import type { KnowledgeDoc } from "../../shared/types";
import { api, errMsg, formatTime } from "../lib/api";
import { Empty } from "../components/ui";

export function KnowledgeScreen() {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [draft, setDraft] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.listKnowledge().then(setDocs), []);

  const run = async (fn: () => Promise<KnowledgeDoc[]>) => {
    setBusy(true);
    setError(null);
    try {
      setDocs(await fn());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <h1>Knowledge</h1>
        <span className="muted small">Reference material Lumen can retrieve when relevant — résumés, job descriptions, product docs, notes.</span>
        <span className="spacer" />
        <button className="btn" onClick={() => setDraft({ title: "", text: "" })}>
          ✎ New note
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void run(() => api.importKnowledge())}>
          {busy ? <span className="spinner" /> : "▤"} Import files
        </button>
      </header>
      <div className="page narrow">
        {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}</div>}
        {draft && (
          <div className="card col" style={{ marginBottom: 16 }}>
            <input className="input" placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea className="textarea" style={{ minHeight: 160 }} placeholder="Paste or write reference text…" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            <div className="row">
              <button
                className="btn primary sm"
                disabled={!draft.text.trim()}
                onClick={() =>
                  void run(async () => {
                    const r = await api.addKnowledgeText(draft.title, draft.text);
                    setDraft(null);
                    return r;
                  })
                }
              >
                Save
              </button>
              <button className="btn ghost sm" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="alert info small" style={{ marginBottom: 16 }}>
          Documents are stored locally and searched on-device. Only the passages most relevant to a question are sent to the AI provider, as untrusted reference data. Supported: text, Markdown, PDF (text layer), HTML, CSV, JSON and source code.
        </div>
        {docs === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : docs.length === 0 ? (
          <Empty title="No reference material yet">Import files or write a note. In interview mode, try adding your résumé and the job description.</Empty>
        ) : (
          docs.map((d) => (
            <div key={d.id} className="card row">
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{d.title}</div>
                <div className="small faint">
                  {d.chars.toLocaleString()} characters · {d.chunkCount} passages · added {formatTime(d.createdAt)}
                </div>
              </div>
              <button
                className="btn sm danger"
                onClick={() => {
                  if (confirm(`Remove “${d.title}” from the knowledge base?`)) void run(() => api.deleteKnowledge(d.id));
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
