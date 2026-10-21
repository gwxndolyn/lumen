import { useEffect, useRef, useState } from "react";
import type { MeetingInsights, Settings, TranscriptSegment, TranscriptSession } from "../../shared/types";
import { api, errMsg, formatTime, formatTs } from "../lib/api";
import { useAppEvent, type LiveTranscript } from "../lib/hooks";
import { Empty } from "../components/ui";

const STATUS_LABEL: Record<string, string> = {
  idle: "Not recording",
  connecting: "Connecting…",
  recording: "Recording",
  paused: "Paused",
  reconnecting: "Reconnecting…",
  stopped: "Stopped",
  error: "Error",
};

export function TranscriptScreen({ settings, live, go }: { settings: Settings; live: LiveTranscript; go: (r: string) => void }) {
  const [sessions, setSessions] = useState<TranscriptSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const active = live.status === "recording" || live.status === "paused" || live.status === "reconnecting" || live.status === "connecting";

  const refresh = () => void api.listTranscripts().then(setSessions);
  useEffect(() => {
    refresh();
    void api.secretsStatus().then((s) => setHasKey(s.deepgram));
  }, [live.status]);
  useAppEvent((e) => e.type === "history-changed" && refresh());

  const viewingLive = selected === null || selected === live.sessionId;
  useEffect(() => {
    if (selected && selected !== live.sessionId) void api.getSegments(selected).then(setSegments);
  }, [selected, live.sessionId]);
  const shown = viewingLive ? live.segments : segments;
  useEffect(() => {
    if (viewingLive) endRef.current?.scrollIntoView({ block: "end" });
  }, [live.segments.length, live.interim, viewingLive]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const sessionId = viewingLive ? live.sessionId : selected;
  const ready = settings.consent.microphone && hasKey && settings.transcription.kind !== "none";

  return (
    <>
      <header className="page-header">
        <h1>Live transcript</h1>
        <span className="row small">
          <span className={`dot ${live.status === "recording" ? "rec" : live.status === "error" ? "err" : active ? "warn" : ""}`} />
          {STATUS_LABEL[live.status]}
          {live.detail && <span className="muted">— {live.detail}</span>}
        </span>
        <span className="spacer" />
        {!active ? (
          <>
            <input className="input" style={{ width: 220 }} placeholder="Session title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button
              className="btn primary"
              disabled={!ready}
              onClick={() =>
                void run(async () => {
                  setSelected(null);
                  await api.transcriptStart(title);
                  setTitle("");
                })
              }
            >
              ● Start recording
            </button>
          </>
        ) : (
          <>
            {live.status === "paused" ? (
              <button className="btn" onClick={() => void api.transcriptResume()}>
                ▶ Resume
              </button>
            ) : (
              <button className="btn" onClick={() => void api.transcriptPause()}>
                ❚❚ Pause
              </button>
            )}
            <button className="btn danger solid" onClick={() => void api.transcriptStop()}>
              ■ Stop
            </button>
          </>
        )}
      </header>
      {!ready && hasKey !== null && (
        <div style={{ padding: "12px 24px 0" }}>
          <div className="alert info">
            {!settings.consent.microphone ? (
              <>
                Microphone access is off. <button className="btn sm" onClick={() => go("permissions")}>Open permissions</button>
              </>
            ) : (
              <>
                Live transcription needs a Deepgram API key. <button className="btn sm" onClick={() => go("provider")}>Add key</button>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <div style={{ padding: "12px 24px 0" }}>
          <div className="alert error">{error}</div>
        </div>
      )}
      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="list" aria-label="Transcript sessions">
          {sessions.length === 0 && <div className="small muted" style={{ padding: 14 }}>No transcripts yet.</div>}
          {sessions.map((s) => (
            <button key={s.id} className="list-item" aria-selected={(selected ?? live.sessionId) === s.id} onClick={() => setSelected(s.id === live.sessionId ? null : s.id)}>
              <div className="title">
                {s.id === live.sessionId && active && <span className="dot rec" style={{ marginRight: 6 }} />}
                {s.title}
              </div>
              <div className="small faint">
                {formatTime(s.startedAt)} · {s.segmentCount} segments
              </div>
            </button>
          ))}
        </div>
        <div className="detail">
          {!sessionId ? (
            <Empty title="Start a live transcript">
              Lumen transcribes the selected microphone{settings.transcription.captureSystemAudio ? " and system audio" : ""} in real time. Audio is streamed to your transcription provider and is never saved; only the finalized text is stored, for{" "}
              {settings.privacy.transcriptRetentionDays ? `${settings.privacy.transcriptRetentionDays} days` : "as long as you keep it"}. Let others know when you are recording.
            </Empty>
          ) : (
            <SessionDetail sessionId={sessionId} segments={shown} interim={viewingLive ? live.interim : null} live={viewingLive && active} onChanged={refresh} endRef={endRef} setError={setError} />
          )}
        </div>
      </div>
    </>
  );
}

function SessionDetail({
  sessionId,
  segments,
  interim,
  live,
  onChanged,
  endRef,
  setError,
}: {
  sessionId: string;
  segments: TranscriptSegment[];
  interim: LiveTranscript["interim"];
  live: boolean;
  onChanged: () => void;
  endRef: React.RefObject<HTMLDivElement | null>;
  setError: (e: string | null) => void;
}) {
  const [insights, setInsights] = useState<MeetingInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string; speaker: string } | null>(null);
  const [local, setLocal] = useState(segments);
  useEffect(() => setLocal(segments), [segments]);
  useEffect(() => {
    setInsights(null);
    void api.getInsights(sessionId).then(setInsights);
  }, [sessionId]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      setInsights(await api.generateInsights(sessionId));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page" style={{ paddingTop: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="label-tag">Transcript</span>
        <span className="small faint">Verbatim recognizer output. Click a line to correct it.</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!local.length} onClick={() => void api.copyText(local.map((s) => `[${formatTs(s.startMs)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`).join("\n"))}>
          Copy
        </button>
        <button className="btn sm primary" disabled={!local.length || loading} onClick={() => void generate()}>
          {loading ? <span className="spinner" /> : "✦"} {insights ? "Refresh notes" : "Generate meeting notes"}
        </button>
        {!live && (
          <button
            className="btn sm danger"
            onClick={() => {
              if (confirm("Delete this transcript and its notes permanently?")) void api.deleteTranscript(sessionId).then(onChanged);
            }}
          >
            Delete
          </button>
        )}
      </div>

      {insights && <Insights insights={insights} />}

      {local.length === 0 && !interim && <div className="muted small" style={{ padding: 8 }}>{live ? "Listening… speak to see the transcript." : "This transcript is empty."}</div>}
      <div role="log" aria-live="polite" aria-label="Transcript">
        {local.map((s) =>
          editing?.id === s.id ? (
            <div key={s.id} className="segment">
              <span className="ts">{formatTs(s.startMs)}</span>
              <div className="col">
                <input className="input" aria-label="Speaker" placeholder="Speaker" value={editing.speaker} onChange={(e) => setEditing({ ...editing, speaker: e.target.value })} />
                <textarea className="textarea" aria-label="Text" value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
              </div>
              <div className="col">
                <button
                  className="btn sm primary"
                  onClick={() => {
                    const speaker = editing.speaker.trim() || null;
                    void api.updateSegment(s.id, editing.text, speaker).then(() => {
                      setLocal((l) => l.map((x) => (x.id === s.id ? { ...x, text: editing.text, speaker, edited: true } : x)));
                      setEditing(null);
                    });
                  }}
                >
                  Save
                </button>
                <button className="btn sm ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div key={s.id} className="segment">
              <span className="ts">{formatTs(s.startMs)}</span>
              <div>
                {s.speaker && <span className="speaker">{s.speaker}</span>}
                {s.text}
                {s.edited && <span className="small faint"> (edited)</span>}
              </div>
              <div className="actions row">
                <button className="btn ghost sm" aria-label="Edit segment" onClick={() => setEditing({ id: s.id, text: s.text, speaker: s.speaker ?? "" })}>
                  Edit
                </button>
                <button
                  className="btn ghost sm"
                  aria-label="Delete segment"
                  onClick={() => void api.deleteSegment(s.id).then(() => setLocal((l) => l.filter((x) => x.id !== s.id)))}
                >
                  ×
                </button>
              </div>
            </div>
          ),
        )}
        {interim && (
          <div className="interim">
            {interim.speaker ? `${interim.speaker}: ` : ""}
            {interim.text}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Insights({ insights }: { insights: MeetingInsights }) {
  const email = `Subject: ${insights.followUpEmail.subject}\n\n${insights.followUpEmail.body}`;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Meeting notes</h3>
        {insights.isMock && <span className="badge warning">Mock — not AI generated</span>}
        <span className="small faint">
          {insights.model} · {formatTime(insights.generatedAt)}
        </span>
      </div>
      <div className="section-label">
        <span className="label-tag">Summary</span> AI summary of the transcript
      </div>
      <p>{insights.summary}</p>
      <div className="insights-grid">
        <div>
          <div className="section-label">
            <span className="label-tag">Summary</span> Key points
          </div>
          <List items={insights.keyPoints} />
        </div>
        <div>
          <div className="section-label">
            <span className="label-tag">Summary</span> Action items
          </div>
          <List items={insights.actionItems.map((a) => (a.owner ? `${a.task} — ${a.owner}` : a.task))} />
        </div>
        <div>
          <div className="section-label">
            <span className="label-tag">Suggestion</span> Questions to ask
          </div>
          <List items={insights.questionsToAsk} />
        </div>
        <div>
          <div className="section-label">
            <span className="label-tag">Suggestion</span> Things you could say
          </div>
          <List items={insights.suggestedResponses} />
        </div>
      </div>
      <div className="section-label">
        <span className="label-tag">Draft</span> Follow-up email
        <button className="btn ghost sm" onClick={() => void api.copyText(email)}>
          Copy
        </button>
      </div>
      <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: 0, background: "var(--code-bg)", padding: 10, borderRadius: 6, border: "1px solid var(--border)" }}>
        {email}
      </pre>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <div className="small faint">Nothing identified.</div>;
  return (
    <ul>
      {items.map((i, n) => (
        <li key={n}>{i}</li>
      ))}
    </ul>
  );
}
