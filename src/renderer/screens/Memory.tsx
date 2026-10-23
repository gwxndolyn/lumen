import { useEffect, useState } from "react";
import type { MemoryView } from "../../shared/api";
import type { Settings } from "../../shared/types";
import { api, errMsg, formatTime } from "../lib/api";
import { Empty, Switch } from "../components/ui";

const KINDS: { value: MemoryView["kind"]; label: string; hint: string }[] = [
  { value: "preference", label: "Preference", hint: "e.g. Prefer functional style; explain trade-offs briefly" },
  { value: "convention", label: "Coding convention", hint: "e.g. Use Kotlin coroutines, never RxJava" },
  { value: "architecture", label: "Architecture", hint: "e.g. MVVM with a repository layer; Room for storage" },
  { value: "decision", label: "Decision", hint: "e.g. We chose PostgreSQL over MongoDB for reporting" },
  { value: "known_issue", label: "Known issue", hint: "e.g. Login fails on Android 10 when the clock is skewed" },
  { value: "task", label: "Open task", hint: "e.g. Migrate the settings screen to Compose" },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label])) as Record<MemoryView["kind"], string>;

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

export function MemoryScreen({ settings, update }: Props) {
  const [items, setItems] = useState<MemoryView[] | null>(null);
  const [kind, setKind] = useState<MemoryView["kind"]>("preference");
  const [text, setText] = useState("");
  const [ttl, setTtl] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    void api
      .listMemories()
      .then(setItems)
      .catch((e) => setError(errMsg(e)));
  useEffect(load, []);

  const act = (p: Promise<unknown>, after?: () => void) =>
    void p
      .then(() => {
        setError(null);
        after?.();
        load();
      })
      .catch((e) => setError(errMsg(e)));

  return (
    <>
      <header className="page-header">
        <h1>Project memory</h1>
        <span className="muted small">Short facts you want Lumen to remember across sessions. Nothing is saved here unless you add it.</span>
      </header>
      <div className="page narrow">
        <div className="card">
          <div className="field">
            <div>
              <div className="label">Use project memory in answers</div>
              <div className="hint">
                Up to 5 relevant memories (1,500 characters) are sent with a question, labelled as your saved memory. Matching is by keywords; preferences and conventions are included when there is
                room.
              </div>
            </div>
            <Switch label="Use project memory" checked={settings.assistant.useProjectMemory} onChange={(v) => void update({ assistant: { useProjectMemory: v } })} />
          </div>
        </div>

        <div className="card">
          <h3>Add a memory</h3>
          <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <select className="select" style={{ width: 180 }} aria-label="Memory type" value={kind} onChange={(e) => setKind(e.target.value as MemoryView["kind"])}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <textarea
              className="textarea"
              style={{ flex: 1, minWidth: 260 }}
              rows={2}
              maxLength={600}
              aria-label="Memory text"
              placeholder={KINDS.find((k) => k.value === kind)!.hint}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="small muted" htmlFor="mem-ttl">
              Keep
            </label>
            <select id="mem-ttl" className="select" style={{ width: 160 }} value={ttl === null ? "" : String(ttl)} onChange={(e) => setTtl(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Until I delete it</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
            <span className="spacer" />
            <span className="small faint">{text.length}/600</span>
            <button
              className="btn primary"
              disabled={!text.trim()}
              onClick={() =>
                act(api.addMemory(kind, text, ttl), () => {
                  setText("");
                })
              }
            >
              Save memory
            </button>
          </div>
          <div className="small faint" style={{ marginTop: 6 }}>
            Don't store secrets: text that looks like a key, password or card number is rejected. Memories are stored locally and sent to your AI provider with relevant questions.
          </div>
        </div>

        {error && (
          <div className="alert error small" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}

        {items === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <Empty title="No memories yet">Add a preference, convention or decision above. Lumen uses them when they are relevant to your question.</Empty>
        ) : (
          <div className="card">
            {items.map((m) => (
              <div key={m.id} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", alignItems: "flex-start" }}>
                <span className="badge" style={{ minWidth: 110, justifyContent: "center" }}>
                  {LABEL[m.kind]}
                </span>
                <div className="grow">
                  {editing?.id === m.id ? (
                    <textarea className="textarea" rows={2} maxLength={600} aria-label="Edit memory" value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                  ) : (
                    <div>{m.text}</div>
                  )}
                  <div className="small faint">
                    Updated {formatTime(m.updatedAt)}
                    {m.lastUsedAt ? ` · last used ${formatTime(m.lastUsedAt)}` : " · not used yet"}
                    {m.expiresAt ? ` · expires ${formatTime(m.expiresAt)}` : ""}
                  </div>
                </div>
                {editing?.id === m.id ? (
                  <>
                    <button className="btn sm primary" disabled={!editing.text.trim()} onClick={() => act(api.updateMemory(m.id, { text: editing.text }), () => setEditing(null))}>
                      Save
                    </button>
                    <button className="btn sm ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => setEditing({ id: m.id, text: m.text })}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={() => confirm("Delete this memory?") && act(api.deleteMemory(m.id))}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
