import { useEffect, useRef, useState } from "react";
import type { Settings } from "../../shared/types";
import { api, formatTs } from "../lib/api";
import { isRecordingStatus, useActiveSession, useChat, useContextItems, type LiveTranscript } from "../lib/hooks";
import { ContextChips, Empty, MessageView, RecordingControls, Segmented, Switch, useAction } from "../components/ui";

const PROFILE_FIELDS: { key: string; label: string; hint: string; rows: number }[] = [
  { key: "resume", label: "Résumé", hint: "Paste your résumé text.", rows: 6 },
  { key: "experience", label: "Work experience", hint: "Roles, scope, teams, technologies — your own words.", rows: 5 },
  { key: "projects", label: "Projects", hint: "Problem, your role, key decisions, outcome.", rows: 5 },
  { key: "accomplishments", label: "Accomplishments", hint: "Only metrics you can stand behind.", rows: 3 },
  { key: "challenges", label: "Past challenges", hint: "Conflicts, failures, hard calls — raw material for STAR answers.", rows: 4 },
  { key: "skills", label: "Technical skills", hint: "Languages, frameworks, tools.", rows: 2 },
  { key: "target", label: "Target role & company", hint: "The role, the company, what they care about.", rows: 3 },
  { key: "style", label: "Preferred answer style", hint: "e.g. concise, confident, avoid jargon.", rows: 2 },
];

function ProfileEditor({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { run, error, busy } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api.getProfile().then((p) => {
      setProfile(p);
      setDraft(p);
    });
  }, []);
  if (!profile) return <div className="spinner" />;
  const dirty = PROFILE_FIELDS.some((f) => (draft[f.key] ?? "") !== (profile[f.key] ?? ""));
  return (
    <div className="col">
      <div className="row">
        <h3 style={{ margin: 0 }}>Interview profile</h3>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Lumen grounds suggested answers in this profile and never invents experience, metrics or credentials it can't find here. Stored locally as knowledge documents available to every session.
      </p>
      {PROFILE_FIELDS.map((f) => (
        <label key={f.key} className="col" style={{ gap: 2 }}>
          <span className="small" style={{ fontWeight: 600 }}>
            {f.label}
          </span>
          <textarea className="textarea" rows={f.rows} placeholder={f.hint} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
        </label>
      ))}
      {error && <div className="alert error small">{error}</div>}
      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty || busy}
          onClick={() =>
            void run(async () => {
              let p = profile;
              for (const f of PROFILE_FIELDS) if ((draft[f.key] ?? "") !== (profile[f.key] ?? "")) p = await api.saveProfile(f.key, draft[f.key] ?? "");
              setProfile(p);
              setDraft(p);
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            })
          }
        >
          Save profile
        </button>
        {saved && <span className="small muted">Saved</span>}
      </div>
    </div>
  );
}

export function InterviewScreen({ settings, update, live, go }: { settings: Settings; update: (p: unknown) => Promise<void>; live: LiveTranscript; go: (r: string) => void }) {
  const session = useActiveSession();
  const chat = useChat(settings, { adoptSuggestions: true, restore: false });
  const items = useContextItems();
  const [text, setText] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileEmpty, setProfileEmpty] = useState<boolean | null>(null);
  const { run, error } = useAction();
  const scrollRef = useRef<HTMLDivElement>(null);
  const recording = isRecordingStatus(live.status) && !live.elsewhere;
  const isInterview = session?.type === "interview";

  useEffect(() => {
    void api.getProfile().then((p) => setProfileEmpty(Object.values(p).every((v) => !v.trim())));
  }, [profileOpen]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages]);

  const ask = (q = text) => {
    if (!q.trim() || chat.busy) return;
    setText("");
    void chat.send(q.trim(), { includeLiveTranscript: recording, mode: { kind: "interview", question: q.trim(), length: settings.interview.length }, label: "Your question" });
  };

  return (
    <>
      <header className="page-header">
        <h1>Interview Copilot</h1>
        {session && <span className="badge">{session.title}</span>}
        <span className="spacer" />
        <Segmented
          label="Answer length"
          value={settings.interview.length}
          options={[
            { value: "short", label: "Short" },
            { value: "medium", label: "Medium" },
            { value: "detailed", label: "Detailed" },
          ]}
          onChange={(v) => void update({ interview: { length: v } })}
        />
        <button className="btn" onClick={() => setProfileOpen((v) => !v)}>
          ✎ Profile
        </button>
      </header>
      {!isInterview && session && (
        <div className="alert info small" style={{ margin: "10px 24px 0" }}>
          Live question detection runs in <strong>Interview</strong> sessions. This session is “{session.title}”.{" "}
          <button
            className="btn sm"
            onClick={() => void run(() => api.createSession({ title: `Interview — ${new Date().toLocaleDateString()}`, type: "interview" }))}
          >
            Start an interview session
          </button>
        </div>
      )}
      <div className="workspace" style={{ flex: 1 }}>
        <div className="pane">
          {profileOpen ? (
            <ProfileEditor onClose={() => setProfileOpen(false)} />
          ) : (
            <div className="col" style={{ gap: 12 }}>
              <div className="card" style={{ margin: 0 }}>
                <h3>Live listening</h3>
                {recording ? (
                  <div className="col">
                    <RecordingControls live={live} />
                    <div className="small muted">
                      Listening for the interviewer's questions{settings.interview.interviewer === "remote" ? " on the system-audio channel" : ""}. A suggestion appears when a question ends.
                    </div>
                  </div>
                ) : (
                  <div className="col">
                    <div className="small muted">Start a live transcript to get suggestions as questions are asked. Make sure the interviewer knows the conversation is being transcribed.</div>
                    <div>
                      <button className="btn primary sm" onClick={() => go("transcript")}>
                        Go to live transcript
                      </button>
                    </div>
                  </div>
                )}
                <div className="field" style={{ padding: "8px 0 0" }}>
                  <div>
                    <div className="label">Suggest answers automatically</div>
                    <div className="hint">Only for complete questions; repeats and small talk are ignored.</div>
                  </div>
                  <Switch label="Suggest automatically" checked={settings.questions.policy === "assisted"} onChange={(v) => void update({ questions: { policy: v ? "assisted" : "manual" } })} />
                </div>
                <div className="col" style={{ gap: 4, paddingTop: 10 }}>
                  <div className="label">Interviewer is</div>
                  <Segmented
                    label="Interviewer"
                    value={settings.interview.interviewer}
                    options={[
                      { value: "any", label: "Anyone but me" },
                      { value: "remote", label: "System audio" },
                    ]}
                    onChange={(v) => void update({ interview: { interviewer: v } })}
                  />
                  <div className="hint small muted">“System audio” is reliable on calls when system audio is enabled.</div>
                </div>
              </div>
              {profileEmpty && (
                <div className="alert warning small">
                  Your interview profile is empty, so suggestions can't reference your own experience — they will point out what to add instead.{" "}
                  <button className="btn sm" onClick={() => setProfileOpen(true)}>
                    Fill in profile
                  </button>
                </div>
              )}
              {live.segments.length > 0 && (
                <div className="card" style={{ margin: 0 }}>
                  <h3>Recent transcript</h3>
                  {live.segments.slice(-8).map((s) => (
                    <div key={s.id} className="small" style={{ padding: "2px 0" }}>
                      <span className="faint mono">{formatTs(s.startMs)} </span>
                      {s.speaker && <strong>{s.speaker}: </strong>}
                      {s.text}
                    </div>
                  ))}
                </div>
              )}
              <ContextChips items={items} />
            </div>
          )}
        </div>
        <div className="pane" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
            {chat.messages.length ? (
              <div className="thread">
                {chat.messages.map((m) => (
                  <MessageView key={m.id} m={m} onCopy={(t) => void api.copyText(t)} />
                ))}
              </div>
            ) : (
              <Empty title="Suggested answers appear here">
                Paste a question below, or start a live transcript in an interview session. Answers use your profile and cite it; anything not in your profile is flagged, never invented.
              </Empty>
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--border)", padding: "10px 18px" }}>
            {error && <div className="alert error small">{error}</div>}
            <div className="row">
              <input className="input" aria-label="Interview question" placeholder="Type or paste a question you were asked…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} />
              {chat.busy ? (
                <button className="btn danger" onClick={chat.cancel}>
                  ■ Stop
                </button>
              ) : (
                <button className="btn primary" disabled={!text.trim()} onClick={() => ask()}>
                  Suggest answer
                </button>
              )}
            </div>
            <div className="row small faint" style={{ marginTop: 6, flexWrap: "wrap" }}>
              Practice:
              {["Tell me about yourself.", "Tell me about a time you disagreed with your manager.", "Walk me through your most impactful project.", "Why do you want this role?"].map((q) => (
                <button key={q} className="btn ghost sm" disabled={chat.busy} onClick={() => ask(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
