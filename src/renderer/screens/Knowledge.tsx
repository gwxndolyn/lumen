import { useEffect, useState } from "react";
import type { KnowledgeDoc, KnowledgeHit, KnowledgeImportResult } from "../../shared/types";
import { api, formatTime } from "../lib/api";
import { useActiveSession, useAppEvent } from "../lib/hooks";
import { Empty, Segmented, useAction } from "../components/ui";

function Snippet({ text }: { text: string }) {
  return (
    <span className="hit">
      {text.split(/(«[^»]*»)/g).map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function KnowledgeScreen() {
  const session = useActiveSession();
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [draft, setDraft] = useState<{ title: string; text: string } | null>(null);
  const [scope, setScope] = useState<"global" | "session">("global");
  const [report, setReport] = useState<KnowledgeImportResult | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const { run, error, busy } = useAction();
  const load = () => void api.listKnowledge().then(setDocs);
  useEffect(load, []);
  useAppEvent((e) => e.type === "session-switched" && load());
  useEffect(() => {
    if (!query.trim()) return setHits(null);
    const t = setTimeout(() => void api.searchKnowledge(query).then(setHits), 200);
    return () => clearTimeout(t);
  }, [query, docs]);

  const doImport = (kind: "files" | "folder") =>
    run(async () => {
      const r = await api.importKnowledge(kind, scope);
      setDocs(r.docs);
      if (r.imported.length || r.failed.length || r.skipped) setReport(r);
    });

  return (
    <>
      <header className="page-header">
        <h1>Knowledge</h1>
        <Segmented
          label="Add to"
          value={scope}
          options={[
            { value: "global", label: "All sessions" },
            { value: "session", label: session ? `This session only` : "This session" },
          ]}
          onChange={setScope}
        />
        <span className="spacer" />
        <button className="btn" onClick={() => setDraft({ title: "", text: "" })}>
          ✎ New note
        </button>
        <button className="btn" disabled={busy} onClick={() => void doImport("folder")}>
          ▣ Import folder
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void doImport("files")}>
          {busy ? <span className="spinner" /> : "▤"} Import files
        </button>
      </header>
      <div className="page narrow">
        {error && (
          <div className="alert error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {report && (
          <div className={`alert ${report.failed.length ? "warning" : "info"} small`} role="status" style={{ marginBottom: 12 }}>
            <div className="row">
              <strong className="grow">
                Imported {report.imported.length} document{report.imported.length === 1 ? "" : "s"}
                {report.failed.length ? `, ${report.failed.length} not imported` : ""}
                {report.skipped ? `, ${report.skipped} unsupported files skipped` : ""}.
              </strong>
              <button className="btn ghost sm" onClick={() => setReport(null)}>
                Dismiss
              </button>
            </div>
            {report.failed.length > 0 && (
              <ul className="import-report">
                {report.failed.map((f) => (
                  <li key={f.file}>
                    <strong>{f.file}</strong>: {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
                    setDocs(await api.addKnowledgeText(draft.title, draft.text, scope));
                    setDraft(null);
                  })
                }
              >
                Save {scope === "session" ? "to this session" : "to all sessions"}
              </button>
              <button className="btn ghost sm" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="alert info small" style={{ marginBottom: 16 }}>
          Only files and folders you choose are imported — Lumen never scans your disk. Documents are stored and searched locally (full-text, BM25). When you ask a question, only the most relevant passages are sent to the AI, as clearly labelled reference material. Supported: text, Markdown, PDF (text layer), Word (.docx), HTML, CSV, JSON and source code.
        </div>
        <input className="input" type="search" placeholder="Search your knowledge base…" aria-label="Search knowledge" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
        {hits && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>
              {hits.length} passage{hits.length === 1 ? "" : "s"} for “{query}”
            </h3>
            {hits.length === 0 ? (
              <div className="small muted">No passages match. Retrieval uses keyword search, so try the words that appear in the document.</div>
            ) : (
              hits.map((h) => (
                <div key={h.chunkId} style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                  <div className="small">
                    <strong>{h.title}</strong> {h.sessionId ? <span className="badge">session</span> : null}
                  </div>
                  <div className="small muted">
                    <Snippet text={h.snippet} />
                  </div>
                </div>
              ))
            )}
          </div>
        )}
        {docs === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : docs.length === 0 ? (
          <Empty title="No reference material yet">Import files or a folder, or write a note. In interview sessions, try adding your résumé and the job description.</Empty>
        ) : (
          docs.map((d) => (
            <div key={d.id} className="card row">
              <div className="grow">
                <div className="row" style={{ fontWeight: 500 }}>
                  {d.title}
                  <span className="badge">{d.format}</span>
                  <span className={`badge ${d.sessionId ? "accent" : ""}`}>{d.sessionId ? "This session" : "All sessions"}</span>
                </div>
                <div className="small faint">
                  {d.chars.toLocaleString()} characters · {d.chunkCount} passages · added {formatTime(d.createdAt)}
                </div>
              </div>
              <button
                className="btn sm danger"
                onClick={() => {
                  if (confirm(`Remove “${d.title}” and its search index from the knowledge base?`)) void run(async () => setDocs(await api.deleteKnowledge(d.id)));
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
