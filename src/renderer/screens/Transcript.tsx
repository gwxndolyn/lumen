import { useEffect, useRef, useState } from "react";
import type { MeetingInsights, Settings, TranscriptSegment, TranscriptSession } from "../../shared/types";
import { api, errMsg, formatTime, formatTs } from "../lib/api";
import { isRecordingStatus, useAppEvent, type LiveTranscript } from "../lib/hooks";
import { listMicrophones } from "../lib/audio";
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

function InputStatus({ live, settings }: { live: LiveTranscript; settings: Settings }) {
  const a = live.audio;
  const quiet = a && a.silentForMs > 8000;
  return (
    <div className="card row small" style={{ gap: 16, flexWrap: "wrap" }} aria-label="Audio input status">
      <span className="row">
        <span className={`dot ${a ? (quiet ? "warn" : "ok") : ""}`} />
        Microphone: <strong>{a?.micLabel ?? "starting…"}</strong>
        {a && (
          <span className="level" style={{ width: 60 }}>
            <span style={{ width: `${Math.round(a.micLevel * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="row">
        <span className={`dot ${a?.systemAudio === "active" ? "ok" : a?.systemAudio === "denied" || a?.systemAudio === "unavailable" ? "warn" : ""}`} />
        System audio:{" "}
        {a?.systemAudio === "active" ? (
          <>
            on
            <span className="level" style={{ width: 60 }}>
              <span style={{ width: `${Math.round(a.systemLevel * 100)}%` }} />
            </span>
          </>
        ) : a?.systemAudio === "denied" ? (
          "permission denied"
        ) : a?.systemAudio === "unavailable" ? (
          "unavailable on this system"
        ) : settings.transcription.captureSystemAudio && settings.consent.systemAudio ? (
          "starting…"
        ) : (
          "off"
        )}
      </span>
      <span className="faint">{live.persisted ? "Saved to this session" : "Memory only — discarded when you stop"}</span>
      {quiet && <span style={{ color: "var(--warning)" }}>No sound detected for {Math.round(a!.silentForMs / 1000)}s — check the selected microphone.</span>}
    </div>
  );
}

export function TranscriptScreen({ settings, live, go }: { settings: Settings; live: LiveTranscript; go: (r: string) => void }) {
  const [sessions, setSessions] = useState<TranscriptSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const active = isRecordingStatus(live.status) && !live.elsewhere;

  const refresh = () => void api.listTranscripts().then(setSessions);
  useEffect(() => {
    refresh();
    void api.secretsStatus().then((s) => setHasKey(s.deepgram));
  }, [live.status, live.sessionId]);
  useEffect(() => {
    void listMicrophones().then(setMics).catch(() => setMics([]));
  }, [settings.consent.microphone]);
  useAppEvent((e) => {
    if (e.type === "history-changed") refresh();
    if (e.type === "session-switched") {
      setSelected(null);
      refresh();
    }
  });

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
  const start = () =>
    run(async () => {
      setSelected(null);
      await api.transcriptStart(title);
      setTitle("");
    });

  return (
    <>
      <header className="page-header">
        <h1>Live transcript</h1>
        <span className="row small" role="status">
          <span className={`dot ${live.status === "recording" ? "rec" : live.status === "error" ? "err" : active ? "warn" : ""}`} />
          {live.elsewhere ? "Recording in another session" : STATUS_LABEL[live.status]}
        </span>
        <span className="spacer" />
        {!active ? (
          <>
            <select
              className="select"
              style={{ width: 200 }}
              aria-label="Microphone"
              value={settings.transcription.microphoneDeviceId ?? ""}
              onChange={(e) => void api.updateSettings({ transcription: { microphoneDeviceId: e.target.value || null } })}
            >
              <option value="">Default microphone</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Microphone ${m.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            <input className="input" style={{ width: 200 }} placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn primary" disabled={!ready || live.elsewhere} title={live.elsewhere ? "Stop the recording in the other session first" : undefined} onClick={() => void start()}>
              ● Start recording
            </button>
          </>
        ) : (
          <>
            {live.status === "paused" ? (
              <button className="btn" onClick={() => void run(() => api.transcriptResume())}>
                ▶ Resume
              </button>
            ) : (
              <button className="btn" onClick={() => void run(() => api.transcriptPause())}>
                ❚❚ Pause
              </button>
            )}
            <button className="btn danger solid" onClick={() => void run(() => api.transcriptStop())}>
              ■ Stop
            </button>
          </>
        )}
      </header>
      <div style={{ padding: "12px 24px 0" }} className="col">
        {!ready && hasKey !== null && (
          <div className="alert info">
            {!settings.consent.microphone ? (
              <>
                Microphone access is off. <button className="btn sm" onClick={() => go("permissions")}>Open permissions</button>
              </>
            ) : settings.transcription.kind === "none" ? (
              <>
                Transcription is turned off. <button className="btn sm" onClick={() => go("provider")}>Choose a provider</button>
              </>
            ) : (
              <>
                Live transcription needs a Deepgram API key. <button className="btn sm" onClick={() => go("provider")}>Add key</button>
              </>
            )}
          </div>
        )}
        {live.elsewhere && (
          <div className="alert warning small">
            A recording is running in another session. Its transcript is only available to that session.{" "}
            <button className="btn sm" onClick={() => void run(() => api.transcriptStop())}>
              Stop it
            </button>
          </div>
        )}
        {live.detail && !live.elsewhere && (
          <div className={`alert ${live.status === "error" ? "error" : live.status === "reconnecting" ? "warning" : "info"} small`} role="alert">
            {live.detail}
            {live.status === "error" && live.action === "retry" && (
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void start()}>
                Start again
              </button>
            )}
            {live.status === "error" && live.action === "settings" && (
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => go("provider")}>
                Fix API key
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="alert error small" role="alert">
            {error}
          </div>
        )}
        {active && <InputStatus live={live} settings={settings} />}
      </div>
      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="list" aria-label="Transcripts in this session">
          {sessions.length === 0 && <div className="small muted" style={{ padding: 14 }}>No transcripts in this session yet.</div>}
          {sessions.map((s) => (
            <button key={s.id} className="list-item" aria-selected={(selected ?? live.sessionId) === s.id} onClick={() => setSelected(s.id === live.sessionId ? null : s.id)}>
              <div className="title">
                {s.id === live.sessionId && active && <span className="dot rec" style={{ marginRight: 6 }} />}
                {s.title}
              </div>
              <div className="small faint">
                {formatTime(s.startedAt)} · {s.segmentCount} segments{s.persisted ? "" : " · memory only"}
              </div>
            </button>
          ))}
        </div>
        <div className="detail">
          {!sessionId ? (
            <Empty title="Start a live transcript">
              Lumen transcribes the selected microphone{settings.transcription.captureSystemAudio && settings.consent.systemAudio ? " and, separately, system audio" : ""} in real time. Audio is streamed to the transcription provider and never saved.{" "}
              {settings.transcription.persist
                ? `Finalized text is stored in this session for ${settings.privacy.transcriptRetentionDays ? `${settings.privacy.transcriptRetentionDays} days` : "as long as you keep it"}.`
                : "Transcripts are kept in memory only and discarded when you stop."}{" "}
              Let others know when you are recording.
            </Empty>
          ) : (
            <SessionDetail sessionId={sessionId} segments={shown} interims={viewingLive ? Object.values(live.interims) : []} live={viewingLive && active} onChanged={refresh} endRef={endRef} setError={setError} />
          )}
        </div>
      </div>
    </>
  );
}

function SessionDetail({
  sessionId,
  segments,
  interims,
  live,
  onChanged,
  endRef,
  setError,
}: {
  sessionId: string;
  segments: TranscriptSegment[];
  interims: { text: string; speaker: string | null }[];
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

      {local.length === 0 && !interims.length && <div className="muted small" style={{ padding: 8 }}>{live ? "Listening… speak to see the transcript." : "This transcript is empty."}</div>}
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
        {interims.map((interim, i) => (
          <div key={i} className="interim">
            {interim.speaker ? `${interim.speaker}: ` : ""}
            {interim.text}
          </div>
        ))}
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
