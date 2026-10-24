import { useCallback, useEffect, useState } from "react";
import type { WsDashboard, WsProject, WsTaskDetail } from "../../shared/api";
import { api, errMsg, formatTime } from "../lib/api";
import { useAppEvent } from "../lib/hooks";
import { Empty, Segmented } from "../components/ui";

// Labels mirror src/core/workspace/tasks.ts (the renderer can't import Node code).
const STATUS: Record<string, [string, string]> = {
  backlog: ["Backlog", ""],
  ready: ["Ready", ""],
  running: ["Running", "accent"],
  waiting_approval: ["Needs approval", "warning"],
  paused: ["Paused", "warning"],
  verifying: ["Verifying", "accent"],
  blocked: ["Blocked", "danger"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", ""],
  completed: ["Completed", "success"],
};
const VSTATUS: Record<string, [string, string]> = {
  running: ["Running", "accent"],
  passed: ["Passed", "success"],
  failed: ["Failed", "danger"],
  timed_out: ["Timed out", "danger"],
  cancelled: ["Cancelled", "warning"],
  error: ["Could not run", "danger"],
  interrupted: ["Interrupted (result unknown)", "warning"],
};
const ROOT_STATUS: Record<string, string> = { available: "", missing: "Folder missing", inaccessible: "Folder not accessible", not_directory: "Not a folder" };
const Badge = ({ map, k }: { map: Record<string, [string, string]>; k: string }) => <span className={`badge ${map[k]?.[1] ?? ""}`}>{map[k]?.[0] ?? k}</span>;

type Tab = "tasks" | "changes" | "verification" | "context" | "settings";

export function WorkspaceScreen() {
  const [projects, setProjects] = useState<WsProject[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      void api.wsProjects().then(
        (p) => {
          setProjects(p);
          setActive((cur) => (cur && p.some((x) => x.id === cur) ? cur : (p[0]?.id ?? null)));
        },
        (e) => setError(errMsg(e)),
      ),
    [],
  );
  useEffect(load, [load]);
  // Task changes alter the per-project badges (needs approval, running), so they refresh the list too.
  useAppEvent((e) => e.type === "workspace" && (e.event.type === "projects-changed" || e.event.type === "task-changed") && load());
  const add = () =>
    void api
      .wsAddProject()
      .then((p) => {
        if (p) {
          setActive(p.id);
          load();
        }
      })
      .catch((e) => setError(errMsg(e)));

  return (
    <>
      <header className="page-header">
        <h1>Projects</h1>
        <span className="muted small">Local folders Lumen may work in. The agent edits files and runs commands only after you approve each one.</span>
        <span className="spacer" />
        <button className="btn primary" onClick={add}>
          Add project folder…
        </button>
      </header>
      <div className="page">
        {error && (
          <div className="alert error small" role="alert" style={{ marginBottom: 12 }}>
            {error}{" "}
            <button className="btn sm ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {projects === null ? (
          <div className="small muted">Loading projects…</div>
        ) : !projects.length ? (
          <Empty
            title="No projects yet"
            action={
              <button className="btn primary" onClick={add}>
                Add project folder…
              </button>
            }
          >
            Add a local project folder to plan tasks, let the agent investigate and propose fixes, review exactly what changed, and run your tests. Removing a project later never deletes its files.
          </Empty>
        ) : (
          <div className="ws-layout">
            <nav className="ws-list" aria-label="Projects">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className="ws-item"
                  aria-current={p.id === active}
                  onClick={() => {
                    setActive(p.id);
                    void api.wsOpenProject(p.id).catch((e) => setError(errMsg(e)));
                  }}
                >
                  <span>{p.name}</span>
                  <span className="small faint" style={{ wordBreak: "break-all" }}>
                    {p.root}
                  </span>
                  <span className="row small" style={{ gap: 4 }}>
                    {p.status !== "available" && <span className="badge danger">{ROOT_STATUS[p.status]}</span>}
                    {(p.taskCounts.waiting_approval ?? 0) > 0 && <span className="badge warning">{p.taskCounts.waiting_approval} need approval</span>}
                    {(p.taskCounts.running ?? 0) > 0 && <span className="badge accent">{p.taskCounts.running} running</span>}
                    {(p.taskCounts.blocked ?? 0) + (p.taskCounts.failed ?? 0) > 0 && <span className="badge danger">{(p.taskCounts.blocked ?? 0) + (p.taskCounts.failed ?? 0)} need attention</span>}
                  </span>
                </button>
              ))}
            </nav>
            {active && <ProjectView key={active} project={projects.find((p) => p.id === active)!} onError={setError} onChanged={load} />}
          </div>
        )}
      </div>
    </>
  );
}

function ProjectView({ project, onError, onChanged }: { project: WsProject; onError: (m: string) => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [dash, setDash] = useState<WsDashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const load = useCallback(
    () =>
      void api.wsDashboard(project.id).then(
        (d) => {
          setDash(d);
          setLoadError(null);
        },
        (e) => setLoadError(errMsg(e)),
      ),
    [project.id],
  );
  const available = project.status === "available";
  // Nothing to load for a folder Lumen can't reach; the relocate prompt is shown instead.
  useEffect(() => (available ? load() : undefined), [load, available]);
  useAppEvent((e) => available && e.type === "workspace" && "projectId" in e.event && e.event.projectId === project.id && load());

  if (project.status !== "available")
    return (
      <div className="card" role="alert">
        <h3>
          {project.name}: {ROOT_STATUS[project.status]}
        </h3>
        <p className="small muted">
          Lumen can't reach <span className="mono">{project.root}</span>. If you moved it, point Lumen at the new location; tasks and history are kept. Nothing runs until the folder is available.
        </p>
        <div className="row">
          <button className="btn primary" onClick={() => void api.wsRelocateProject(project.id).then(onChanged, (e) => onError(errMsg(e)))}>
            Locate folder…
          </button>
          <RemoveProject project={project} onError={onError} onChanged={onChanged} />
        </div>
      </div>
    );
  if (loadError)
    return (
      <div className="alert error" role="alert">
        Could not load {project.name}: {loadError}{" "}
        <button className="btn sm" onClick={load}>
          Try again
        </button>
      </div>
    );
  if (!dash) return <div className="small muted">Loading {project.name}…</div>;

  const attention = dash.tasks.filter((t) => ["waiting_approval", "blocked", "failed", "paused"].includes(t.status));
  return (
    <div className="col" style={{ gap: 12, minWidth: 0 }}>
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 16 }}>{project.name}</h2>
        <span className="spacer" />
        <Segmented<Tab>
          label="Project view"
          value={tab}
          onChange={(v) => {
            setTab(v);
            setTaskId(null);
          }}
          options={[
            { value: "tasks", label: "Tasks" },
            { value: "changes", label: `Changes${dash.changes.length ? ` (${dash.changes.length})` : ""}` },
            { value: "verification", label: "Verification" },
            { value: "context", label: "Context" },
            { value: "settings", label: "Settings" },
          ]}
        />
      </div>
      {tab === "tasks" &&
        (taskId ? (
          <TaskView projectId={project.id} taskId={taskId} onBack={() => setTaskId(null)} onError={onError} />
        ) : (
          <>
            {(attention.length > 0 || dash.approvals.length > 0) && (
              <div className="card">
                <h3>Needs you</h3>
                {attention.map((t) => (
                  <div key={t.id} className="row small" style={{ marginBottom: 4 }}>
                    <Badge map={STATUS} k={t.status} />
                    <span className="grow">{t.title}</span>
                    {t.reason && <span className="faint">{t.reason.slice(0, 90)}</span>}
                    <button className="btn sm" onClick={() => setTaskId(t.id)}>
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
            <NewTask projectId={project.id} onCreated={(id) => setTaskId(id)} onError={onError} />
            <TaskList dash={dash} onOpen={setTaskId} />
            <Activity dash={dash} />
          </>
        ))}
      {tab === "changes" && <Changes projectId={project.id} dash={dash} onError={onError} onChanged={load} />}
      {tab === "verification" && <Verification projectId={project.id} project={project} dash={dash} onError={onError} />}
      {tab === "context" && <Context projectId={project.id} />}
      {tab === "settings" && <ProjectSettingsView project={project} onError={onError} onChanged={onChanged} />}
    </div>
  );
}

function NewTask({ projectId, onCreated, onError }: { projectId: string; onCreated: (id: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [verify, setVerify] = useState(true);
  return (
    <div className="card">
      <h3>New task</h3>
      <textarea
        className="textarea"
        rows={3}
        maxLength={20_000}
        aria-label="Task description"
        placeholder="e.g. Investigate why the tests fail, find the root cause, propose a fix, then run the tests."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <label className="row small">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          Require a passing verification run before it counts as complete
        </label>
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={!text.trim()}
          onClick={() =>
            void api.wsCreateTask(projectId, { description: text, verificationRequired: verify }).then(
              (t) => {
                setText("");
                onCreated(t.id);
              },
              (e) => onError(errMsg(e)),
            )
          }
        >
          Create task
        </button>
      </div>
    </div>
  );
}

function TaskList({ dash, onOpen }: { dash: WsDashboard; onOpen: (id: string) => void }) {
  const groups: [string, string[]][] = [
    ["Active", ["running", "verifying", "waiting_approval", "paused"]],
    ["Ready and backlog", ["ready", "backlog"]],
    ["Blocked or failed", ["blocked", "failed"]],
    ["Done", ["completed", "cancelled"]],
  ];
  if (!dash.tasks.length) return <Empty title="No tasks yet">Describe what you want done above. The agent plans it, then asks before editing any file or running a command.</Empty>;
  return (
    <div className="card">
      {groups.map(([label, st]) => {
        const ts = dash.tasks.filter((t) => st.includes(t.status));
        if (!ts.length) return null;
        return (
          <div key={label} style={{ marginBottom: 10 }}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {label}
            </div>
            {ts.map((t) => (
              <button key={t.id} className="ws-item" onClick={() => onOpen(t.id)}>
                <span className="row" style={{ gap: 6 }}>
                  <Badge map={STATUS} k={t.status} />
                  <span>{t.title}</span>
                </span>
                <span className="small faint">
                  Updated {formatTime(t.updatedAt)}
                  {t.reason ? ` · ${t.reason.slice(0, 100)}` : ""}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Activity({ dash }: { dash: WsDashboard }) {
  if (!dash.activity.length) return null;
  return (
    <div className="card">
      <h3>Recent activity</h3>
      {dash.activity.slice(0, 12).map((e) => (
        <div key={e.id} className="row small">
          <span className="faint" style={{ minWidth: 120 }}>
            {formatTime(e.at)}
          </span>
          <span className="badge">{e.kind}</span>
          <span className="grow">{e.summary}</span>
        </div>
      ))}
    </div>
  );
}

function TaskView({ projectId, taskId, onBack, onError }: { projectId: string; taskId: string; onBack: () => void; onError: (m: string) => void }) {
  const [d, setD] = useState<WsTaskDetail | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const load = useCallback(() => void api.wsTaskDetail(projectId, taskId).then(setD, (e) => onError(errMsg(e))), [projectId, taskId, onError]);
  useEffect(load, [load]);
  useAppEvent((e) => {
    if (e.type !== "workspace") return;
    if (e.event.type === "run-progress" && e.event.taskId === taskId) setProgress(e.event.message);
    if ((e.event.type === "task-changed" && e.event.taskId === taskId) || e.event.type === "verification") load();
  });
  const act = (a: Parameters<typeof api.wsTaskAction>[2]) =>
    void api
      .wsTaskAction(projectId, taskId, a)
      .then(() => (a === "delete" ? onBack() : load()))
      .catch((e) => onError(errMsg(e)));
  if (!d) return <div className="small muted">Loading task…</div>;
  const t = d.task;
  const pending = d.approvals.filter((a) => a.status === "pending");
  const canStart = ["ready", "backlog", "paused", "blocked", "failed", "cancelled"].includes(t.status) && !d.running;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <button className="btn ghost sm" onClick={onBack}>
          ← Tasks
        </button>
        <Badge map={STATUS} k={t.status} />
        <strong className="grow">{t.title}</strong>
        {canStart && (
          <button className="btn primary sm" onClick={() => act("start")}>
            {t.status === "ready" || t.status === "backlog" ? "Start agent" : "Resume"}
          </button>
        )}
        {d.running && (
          <button className="btn sm" onClick={() => act("pause")}>
            Pause
          </button>
        )}
        {!["completed", "cancelled"].includes(t.status) && (
          <button className="btn sm ghost" onClick={() => act("cancel")}>
            Cancel
          </button>
        )}
        {["failed", "cancelled", "blocked", "completed"].includes(t.status) && (
          <button className="btn sm ghost" onClick={() => act("retry")}>
            Back to ready
          </button>
        )}
        {!d.running && (
          <button className="btn sm ghost danger" onClick={() => act("delete")}>
            Delete task
          </button>
        )}
      </div>
      {d.running && progress && (
        <div className="alert info small" role="status">
          Agent: {progress}
        </div>
      )}
      {t.reason && <div className={`alert ${["blocked", "failed"].includes(t.status) ? "error" : "warning"} small`}>{t.reason}</div>}
      {(t.status === "paused" || t.status === "blocked" || t.checkpoint) && (
        <div className="card">
          <h3>Where this task stands</h3>
          <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {d.recovery.text}
          </pre>
        </div>
      )}
      {pending.map((a) => (
        <Approval key={a.id} projectId={projectId} a={a} onDone={load} onError={onError} />
      ))}
      <Plan projectId={projectId} d={d} onChanged={load} onError={onError} />
      {d.blocker && t.status !== "completed" && <div className="small muted">Completion: {d.blocker}</div>}
      {d.changes.length > 0 && (
        <div className="card">
          <h3>Changes by this task</h3>
          {d.changes.map((c) => (
            <ChangeRow key={c.id} projectId={projectId} c={c} onChanged={load} onError={onError} />
          ))}
        </div>
      )}
      {d.verifications.length > 0 && (
        <div className="card">
          <h3>Verification</h3>
          {d.verifications.map((v) => (
            <VerificationRow key={v.id} v={v} projectId={projectId} />
          ))}
        </div>
      )}
      <div className="card">
        <h3>History</h3>
        <p className="small faint">Every action the agent took and what Lumen observed. Commands, edits and test results here actually happened.</p>
        {d.events.map((e) => (
          <details key={e.id} className="small">
            <summary>
              <span className="faint">{formatTime(e.at)}</span> <span className="badge">{e.kind}</span> {e.summary}
            </summary>
            {e.data != null && <pre className="ws-output">{JSON.stringify(e.data, null, 2).slice(0, 6000)}</pre>}
          </details>
        ))}
      </div>
    </div>
  );
}

function Approval({ projectId, a, onDone, onError }: { projectId: string; a: WsTaskDetail["approvals"][number]; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const payload = a.payload as { path?: string; argv?: string[]; reason?: string };
  const decide = (d: "approved" | "denied") => {
    setBusy(true);
    void api
      .wsDecide(projectId, a.id, d)
      .then(onDone, (e) => onError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="card" style={{ borderColor: "var(--warning)" }} role="region" aria-label="Approval request">
      <h3>{a.kind === "edit" ? `Approve edit to ${payload.path}?` : `Approve running this command?`}</h3>
      {payload.reason && <p className="small">Agent's reason: {payload.reason}</p>}
      {a.kind === "command" && (
        <>
          <pre className="ws-output">{JSON.stringify(payload.argv)}</pre>
          <p className="small muted">
            Runs in the project folder without a shell, with a timeout, and without your API keys in its environment. It can still do anything this program can do — only approve commands you
            understand.
          </p>
        </>
      )}
      {a.diff && <DiffView diff={a.diff} />}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => decide("approved")}>
          {a.kind === "edit" ? "Approve and write file" : "Approve and run"}
        </button>
        <button className="btn" disabled={busy} onClick={() => decide("denied")}>
          Reject
        </button>
      </div>
    </div>
  );
}

function DiffView({
  diff,
}: {
  diff: { hunks: { oldStart: number; newStart: number; lines: { kind: string; text: string; oldNo: number | null; newNo: number | null }[] }[]; added: number; removed: number; tooLarge: boolean };
}) {
  if (diff.tooLarge)
    return (
      <div className="small muted">
        Too large to show a line diff (+{diff.added} / −{diff.removed} lines).
      </div>
    );
  return (
    <div className="diff" role="table" aria-label={`Diff: ${diff.added} lines added, ${diff.removed} removed`}>
      {diff.hunks.map((h, i) => (
        <div key={i}>
          <div className="hunk">
            @@ −{h.oldStart} +{h.newStart} @@
          </div>
          {h.lines.map((l, j) => (
            <div key={j} className={`ln ${l.kind === "ctx" ? "" : l.kind}`} role="row">
              <span>{l.oldNo ?? ""}</span>
              <span>{l.newNo ?? ""}</span>
              <span>
                {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                {l.text}
              </span>
            </div>
          ))}
        </div>
      ))}
      {!diff.hunks.length && <div className="hunk">No line changes.</div>}
    </div>
  );
}

function Plan({ projectId, d, onChanged, onError }: { projectId: string; d: WsTaskDetail; onChanged: () => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState("");
  const steps = d.steps;
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  return (
    <div className="card">
      <h3>Plan</h3>
      {!steps.length && <p className="small muted">No plan yet. The agent writes one when it starts, or add steps yourself (one per line).</p>}
      {steps.map((s, i) => (
        <div key={s.id} className="row small" style={{ marginBottom: 4 }}>
          <span className="faint">{i + 1}.</span>
          <select
            className="select"
            style={{ width: 110 }}
            aria-label={`Status of step ${i + 1}`}
            value={s.status}
            onChange={(e) =>
              void api
                .wsSetStep(projectId, d.task.id, s.id, e.target.value)
                .then(onChanged)
                .catch((err) => onError(errMsg(err)))
            }
          >
            {["todo", "doing", "done", "skipped", "blocked"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <span className="grow">{s.title}</span>
          {s.dependsOn.length > 0 && <span className="faint">after {s.dependsOn.map((x) => (idx.get(x) ?? 0) + 1).join(", ")}</span>}
          {s.note && <span className="faint">— {s.note}</span>}
        </div>
      ))}
      {!d.running && (
        <div className="col" style={{ marginTop: 6 }}>
          <textarea
            className="textarea"
            rows={2}
            aria-label="Plan steps, one per line"
            placeholder="One step per line; each depends on the one before"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="row">
            <button
              className="btn sm"
              disabled={!draft.trim()}
              onClick={() => {
                const lines = draft
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean);
                void api
                  .wsSetPlan(
                    projectId,
                    d.task.id,
                    lines.map((title, i) => ({ title, dependsOn: i ? [i - 1] : [] })),
                  )
                  .then(() => {
                    setDraft("");
                    onChanged();
                  })
                  .catch((e) => onError(errMsg(e)));
              }}
            >
              {steps.length ? "Replace plan" : "Set plan"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChangeRow({ projectId, c, onChanged, onError }: { projectId: string; c: WsDashboard["changes"][number]; onChanged: () => void; onError: (m: string) => void }) {
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.wsChangeDiff>>["diff"] | null>(null);
  const state: Record<string, string> = { as_applied: "", modified_since: "Edited since", missing: "File missing", unavailable: "Unavailable" };
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row small">
        <span className="badge">{c.kind}</span>
        <span className="mono grow">{c.path}</span>
        {c.status !== "applied" && <span className={`badge ${c.status === "conflict" ? "danger" : ""}`}>{c.status}</span>}
        {state[c.current] && <span className="badge warning">{state[c.current]}</span>}
        <span className="faint">{formatTime(c.createdAt)}</span>
        <button
          className="btn sm ghost"
          onClick={() =>
            diff
              ? setDiff(null)
              : void api.wsChangeDiff(projectId, c.id).then(
                  (r) => setDiff(r.diff),
                  (e) => onError(errMsg(e)),
                )
          }
        >
          {diff ? "Hide diff" : "Diff"}
        </button>
        {c.status === "applied" && (
          <button
            className="btn sm ghost"
            title={c.current === "as_applied" ? "Restore the file as it was before this change" : "The file changed after the agent's edit; Lumen won't overwrite newer work"}
            onClick={() => void api.wsRevert(projectId, c.id).then(onChanged, (e) => onError(errMsg(e)))}
          >
            Revert
          </button>
        )}
      </div>
      {c.note && <div className="small faint">{c.note}</div>}
      {diff && <DiffView diff={diff} />}
    </div>
  );
}

function Changes({ projectId, dash, onError, onChanged }: { projectId: string; dash: WsDashboard; onError: (m: string) => void; onChanged: () => void }) {
  const [git, setGit] = useState<Awaited<ReturnType<typeof api.wsGit>> | null>(null);
  useEffect(() => void api.wsGit(projectId).then(setGit, () => setGit(null)), [projectId, dash]);
  const agentPaths = new Set(dash.changes.filter((c) => c.status === "applied").map((c) => c.path));
  return (
    <>
      <div className="card">
        <h3>Changes made by Lumen's agent</h3>
        {!dash.changes.length ? (
          <p className="small muted">None yet. Every file the agent writes is recorded here with its task, a diff, and a revert that refuses to overwrite later edits.</p>
        ) : (
          dash.changes.map((c) => <ChangeRow key={c.id} projectId={projectId} c={c} onChanged={onChanged} onError={onError} />)
        )}
      </div>
      <div className="card">
        <h3>Git</h3>
        {!git ? (
          <div className="small muted">Reading Git status…</div>
        ) : !git.available ? (
          <div className="small muted">{git.reason}</div>
        ) : (
          <>
            <div className="small">
              Branch <span className="mono">{git.branch}</span>
              {git.head ? ` @ ${git.head}` : ""}
              {git.ahead != null ? ` · ${git.ahead} ahead, ${git.behind} behind` : ""}. Read-only: Lumen never commits, resets or stashes.
            </div>
            {!git.files.length && <div className="small muted">Working tree clean.</div>}
            {git.files.map((f) => (
              <div key={f.path} className="row small">
                <span className="mono" style={{ minWidth: 28 }}>
                  {f.untracked ? "??" : `${f.index}${f.worktree}`}
                </span>
                <span className="mono grow">{f.path}</span>
                {agentPaths.has(f.path) ? <span className="badge accent">agent</span> : <span className="badge">yours or earlier</span>}
              </div>
            ))}
            {git.recent.length > 0 && (
              <details className="small" style={{ marginTop: 6 }}>
                <summary>Recent commits</summary>
                {git.recent.map((c) => (
                  <div key={c.hash}>
                    <span className="mono">{c.hash}</span> {c.subject} <span className="faint">— {c.author}</span>
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}

function VerificationRow({ v, projectId }: { v: WsDashboard["verifications"][number]; projectId: string }) {
  return (
    <details className="small" style={{ marginBottom: 4 }}>
      <summary>
        <Badge map={VSTATUS} k={v.status} /> <span className="mono">{v.label}</span> <span className="faint">{formatTime(v.startedAt)}</span>
        {v.exitCode != null && <span className="faint"> · exit {v.exitCode}</span>}
        {v.status === "passed" && !v.current && <span className="badge warning"> out of date</span>}
        {v.status === "running" && (
          <button className="btn sm ghost" onClick={() => void api.wsCancelVerification(projectId, v.id)}>
            Stop
          </button>
        )}
      </summary>
      <div className="faint">
        <span className="mono">{JSON.stringify(v.argv)}</span> in <span className="mono">{v.cwd}</span>
      </div>
      <pre className="ws-output">{v.output || "(no output)"}</pre>
    </details>
  );
}

function Verification({ projectId, project, dash, onError }: { projectId: string; project: WsProject; dash: WsDashboard; onError: (m: string) => void }) {
  const cmds = project.settings.verifyCommands;
  return (
    <div className="card">
      <h3>Builds and tests</h3>
      <p className="small muted">Results of commands Lumen actually ran. A pass is marked out of date as soon as project files change after it.</p>
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {cmds.length ? (
          cmds.map((c) => (
            <button key={c.label} className="btn sm" onClick={() => void api.wsVerify(projectId, { argv: c.argv, label: c.label }).catch((e) => onError(errMsg(e)))}>
              Run {c.label}
            </button>
          ))
        ) : (
          <span className="small muted">No verification commands yet. Add one in Settings (e.g. npm test).</span>
        )}
      </div>
      {!dash.verifications.length ? <div className="small muted">Not run yet.</div> : dash.verifications.map((v) => <VerificationRow key={v.id} v={v} projectId={projectId} />)}
    </div>
  );
}

function Context({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.wsSearch>> | null>(null);
  const [ix, setIx] = useState<Awaited<ReturnType<typeof api.wsIndex>> | null>(null);
  const [busy, setBusy] = useState(false);
  const reindex = () => {
    setBusy(true);
    void api
      .wsIndex(projectId)
      .then(setIx, () => setIx(null))
      .finally(() => setBusy(false));
  };
  useEffect(reindex, [projectId]);
  return (
    <div className="card">
      <h3>Project files</h3>
      {busy ? (
        <div className="small muted">Indexing…</div>
      ) : ix ? (
        <div className="small muted">
          {ix.files.toLocaleString()} files indexed{ix.status === "partial" ? " (partial)" : ix.status === "failed" ? " — indexing failed" : ""}. Skipped: {ix.skipped.protected} protected
          (credentials/keys, never read), {ix.skipped.ignored} ignored, {ix.skipped.large} too large, {ix.skipped.binary} binary.{ix.note ? ` ${ix.note}` : ""}{" "}
          <button className="btn sm ghost" onClick={reindex}>
            Re-index
          </button>
        </div>
      ) : null}
      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void api.wsSearch(projectId, q).then(setHits, () => setHits([]));
        }}
      >
        <input className="input grow" aria-label="Search project files" placeholder="Search filenames, symbols or text" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={!q.trim()}>
          Search
        </button>
      </form>
      {hits && (
        <div style={{ marginTop: 8 }}>
          {!hits.length && <div className="small muted">No matches.</div>}
          {hits.map((h, i) => (
            <div key={i} className="row small">
              <span className="badge">{h.kind}</span>
              <span className="mono">
                {h.rel}
                {h.line ? `:${h.line}` : ""}
              </span>
              <span className="faint grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.kind !== "name" ? h.text : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RemoveProject({ project, onError, onChanged }: { project: WsProject; onError: (m: string) => void; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className="row small">
      Remove {project.name} and its tasks, history and change records from Lumen? The folder and its files are not touched.
      <button className="btn sm danger" onClick={() => void api.wsRemoveProject(project.id).then(onChanged, (e) => onError(errMsg(e)))}>
        Remove from Lumen
      </button>
      <button className="btn sm ghost" onClick={() => setConfirm(false)}>
        Keep
      </button>
    </span>
  ) : (
    <button className="btn ghost" onClick={() => setConfirm(true)}>
      Remove from Lumen…
    </button>
  );
}

function ProjectSettingsView({ project, onError, onChanged }: { project: WsProject; onError: (m: string) => void; onChanged: () => void }) {
  const s = project.settings;
  const [name, setName] = useState(project.name);
  const [excludes, setExcludes] = useState(s.excludes.join("\n"));
  const [verify, setVerify] = useState(s.verifyCommands.map((c) => `${c.label}: ${c.argv.join(" ")}`).join("\n"));
  const [timeout, setTimeoutSec] = useState(s.commandTimeoutSec);
  const [notes, setNotes] = useState(project.notes);
  const [saved, setSaved] = useState(false);
  const save = () => {
    // "label: cmd arg arg" — split on spaces; no shell, so quoting rules don't apply.
    const verifyCommands = verify
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^([^:]{1,80}):\s*(.+)$/.exec(l);
        const cmd = (m ? m[2]! : l).split(/\s+/).filter(Boolean);
        return { label: m ? m[1]!.trim() : cmd.join(" "), argv: cmd };
      });
    const work = async () => {
      if (name.trim() !== project.name) await api.wsRenameProject(project.id, name);
      await api.wsSettings(project.id, {
        excludes: excludes
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        verifyCommands,
        commandTimeoutSec: timeout,
        notes,
      });
    };
    void work().then(
      () => {
        setSaved(true);
        onChanged();
      },
      (e) => onError(errMsg(e)),
    );
  };
  return (
    <div className="card">
      <h3>Project settings</h3>
      <div className="field">
        <label htmlFor="ws-name">Name</label>
        <input id="ws-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Folder</label>
        <div className="row small">
          <span className="mono grow">{project.root}</span>
          <button className="btn sm" onClick={() => void api.wsRelocateProject(project.id).then(onChanged, (e) => onError(errMsg(e)))}>
            Change…
          </button>
        </div>
        <div className="small faint">The agent can only read and write inside this folder. Links leading outside it are not followed.</div>
      </div>
      <div className="field">
        <label htmlFor="ws-verify">Verification commands</label>
        <textarea id="ws-verify" className="textarea" rows={3} value={verify} placeholder={"test: npm test\nlint: npm run lint"} onChange={(e) => setVerify(e.target.value)} />
        <div className="small faint">
          One per line as “label: command”. These run without asking (no shell; split on spaces). Any other command the agent wants to run needs your approval each time.
        </div>
      </div>
      <div className="field">
        <label htmlFor="ws-timeout">Command timeout (seconds)</label>
        <input id="ws-timeout" className="input" type="number" min={5} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
      </div>
      <div className="field">
        <label htmlFor="ws-ex">Excluded from indexing and search</label>
        <textarea id="ws-ex" className="textarea" rows={3} value={excludes} placeholder={"fixtures/large/\n*.snap"} onChange={(e) => setExcludes(e.target.value)} />
        <div className="small faint">.gitignore syntax. node_modules, build output and credentials (.env, keys) are always excluded.</div>
      </div>
      <div className="field">
        <label htmlFor="ws-notes">Project notes for the agent</label>
        <textarea id="ws-notes" className="textarea" rows={3} value={notes} placeholder="Conventions, how to run things, what not to touch" onChange={(e) => setNotes(e.target.value)} />
        <div className="small faint">Sent with this project's agent runs only. Never shared with other projects.</div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={save}>
          Save
        </button>
        {saved && <span className="small faint">Saved.</span>}
        <span className="spacer" />
        <RemoveProject project={project} onError={onError} onChanged={onChanged} />
      </div>
    </div>
  );
}
