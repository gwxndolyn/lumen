import { useEffect, useState } from "react";
import { MODE_LABELS, MODELS, STYLE_LABELS } from "../../shared/defaults";
import type { AnswerStyle, AssistantMode, Effort, SessionSummary } from "../../shared/types";
import { api, formatTime } from "../lib/api";
import { useActiveSession, useAppEvent } from "../lib/hooks";
import { Empty, useAction } from "../components/ui";

const TTL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "App default" },
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 480, label: "8 hours" },
  { value: 1440, label: "1 day" },
  { value: 0, label: "Until the session is deleted" },
];

function SessionForm({
  initial,
  onSave,
  onCancel,
  submitLabel,
}: {
  initial: { title: string; type: AssistantMode; notes: string; contextTtlMinutes: number | null; ai: { model?: string; effort?: Effort; style?: AnswerStyle } };
  onSave: (v: typeof initial) => Promise<unknown>;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [v, setV] = useState(initial);
  const { run, error, busy } = useAction();
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="field">
        <label htmlFor="s-title">Title</label>
        <input id="s-title" className="input" value={v.title} placeholder="e.g. Acme interview — Thursday" onChange={(e) => setV({ ...v, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="s-type">Session type</label>
        <select id="s-type" className="select" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as AssistantMode })}>
          {Object.entries(MODE_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <div>
          <label htmlFor="s-notes">Session notes</label>
          <div className="hint">Background the assistant should know for this session (goals, agenda, role). Sent as context with every question in this session.</div>
        </div>
        <textarea id="s-notes" className="textarea" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </div>
      <div className="field">
        <div>
          <label htmlFor="s-ttl">Context expiration</label>
          <div className="hint">How long attached notes, clipboard text and documents stay available. Screen captures always expire.</div>
        </div>
        <select id="s-ttl" className="select" value={v.contextTtlMinutes === null ? "" : String(v.contextTtlMinutes)} onChange={(e) => setV({ ...v, contextTtlMinutes: e.target.value === "" ? null : Number(e.target.value) })}>
          {TTL_OPTIONS.map((o) => (
            <option key={String(o.value)} value={o.value === null ? "" : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <div>
          <div className="label">AI overrides</div>
          <div className="hint">Optional. Used only in this session.</div>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select aria-label="Model override" className="select" style={{ width: 200 }} value={v.ai.model ?? ""} onChange={(e) => setV({ ...v, ai: { ...v.ai, model: e.target.value || undefined } })}>
            <option value="">Default model</option>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select aria-label="Effort override" className="select" style={{ width: 150 }} value={v.ai.effort ?? ""} onChange={(e) => setV({ ...v, ai: { ...v.ai, effort: (e.target.value || undefined) as Effort | undefined } })}>
            <option value="">Default effort</option>
            <option value="low">Low effort</option>
            <option value="medium">Medium effort</option>
            <option value="high">High effort</option>
          </select>
          <select aria-label="Answer style override" className="select" style={{ width: 200 }} value={v.ai.style ?? ""} onChange={(e) => setV({ ...v, ai: { ...v.ai, style: (e.target.value || undefined) as AnswerStyle | undefined } })}>
            <option value="">Answer style from panel</option>
            {Object.entries(STYLE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                Always: {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="alert error small">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !v.title.trim()} onClick={() => void run(() => onSave(v))}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function SessionsScreen() {
  const active = useActiveSession();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const load = () => void api.listSessions().then(setSessions);
  useEffect(load, []);
  useAppEvent((e) => (e.type === "sessions-changed" || e.type === "session-switched") && load());

  return (
    <>
      <header className="page-header">
        <h1>Sessions</h1>
        <span className="muted small">Each session keeps its own conversations, transcripts, notes, documents and context — nothing is shared between sessions.</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          ＋ New session
        </button>
      </header>
      <div className="page narrow">
        {status && (
          <div className="alert info small" role="status" style={{ marginBottom: 12 }}>
            {status}
          </div>
        )}
        {creating && (
          <div className="card">
            <h3>New session</h3>
            <SessionForm
              submitLabel="Create and switch"
              initial={{ title: "", type: "general", notes: "", contextTtlMinutes: null, ai: {} }}
              onCancel={() => setCreating(false)}
              onSave={async (v) => {
                await api.createSession(v);
                setCreating(false);
              }}
            />
          </div>
        )}
        {sessions === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <Empty title="No sessions yet">Create a session for each meeting, interview or task.</Empty>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className={`card ${active?.id === s.id ? "session-card active" : "session-card"}`}>
              {editing === s.id ? (
                <div style={{ gridColumn: "1 / -1" }}>
                  <SessionForm
                    submitLabel="Save"
                    initial={{ title: s.title, type: s.type, notes: s.notes, contextTtlMinutes: s.contextTtlMinutes, ai: s.ai }}
                    onCancel={() => setEditing(null)}
                    onSave={async (v) => {
                      await api.updateSession(s.id, v);
                      setEditing(null);
                    }}
                  />
                </div>
              ) : (
                <>
                  <div>
                    <div className="row">
                      <strong>{s.title}</strong>
                      <span className="badge">{MODE_LABELS[s.type]}</span>
                      {active?.id === s.id && <span className="badge accent">Active</span>}
                    </div>
                    <div className="small faint" style={{ marginTop: 4 }}>
                      {s.conversations} conversations · {s.transcripts} transcripts · {s.documents} documents · {s.contextItems} saved context items · updated {formatTime(s.updatedAt)}
                    </div>
                    {s.notes && <div className="small muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{s.notes.slice(0, 240)}</div>}
                  </div>
                  <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {active?.id !== s.id && (
                      <button className="btn sm primary" onClick={() => void api.switchSession(s.id)}>
                        Switch
                      </button>
                    )}
                    <button className="btn sm" onClick={() => setEditing(s.id)}>
                      Edit
                    </button>
                    <button className="btn sm" onClick={() => void api.exportSession(s.id).then((p) => p && setStatus(`Exported to ${p}`))}>
                      Export
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={() => {
                        if (confirm(`Delete “${s.title}”?\n\nThis permanently deletes its conversations, transcripts, meeting notes, session documents and saved context, including their search index. Global knowledge documents are not affected.`))
                          void api.deleteSession(s.id).then(() => setStatus(`Deleted “${s.title}”.`));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
