// Persistence for the project workspace (migration 10). Thin, typed accessors over the shared
// SQLite store; every query that touches a project-scoped table takes a project id, so a caller
// can't read another project's rows by passing only a task or change id.

import { randomUUID } from "node:crypto";
import type { Store } from "../storage/db";
import type { StepStatus, TaskStatus } from "./tasks";

type Row = Record<string, unknown>;
const json = <T>(s: unknown, fb: T): T => {
  try {
    return s == null ? fb : (JSON.parse(String(s)) as T);
  } catch {
    return fb;
  }
};

export interface ProjectSettings {
  /** Extra .gitignore-style exclusions for indexing and search. */
  excludes: string[];
  /** Verification commands the user approved for this project (argv arrays). Run without asking again. */
  verifyCommands: { label: string; argv: string[] }[];
  /** Commands the agent may run without a per-run approval. Empty = always ask. */
  allowedCommands: string[][];
  /** Agent file edits: always ask (default) or allowed after the task's plan is approved. */
  editPolicy: "ask_each" | "ask_once_per_task";
  commandTimeoutSec: number;
  /** Optional per-project model (same provider as the global setting). */
  model: string | null;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { excludes: [], verifyCommands: [], allowedCommands: [], editPolicy: "ask_each", commandTimeoutSec: 300, model: null };

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastOpenedAt: number | null;
  settings: ProjectSettings;
  notes: string;
}

export interface Checkpoint {
  /** Fingerprints of files the task read or changed, at the time of the checkpoint. */
  files: Record<string, string>;
  findings: string[];
  openQuestions: string[];
  nextAction: string | null;
  /** Run id that was active when the checkpoint was written. */
  runId: string | null;
  at: number;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  tags: string[];
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  checkpoint: Checkpoint | null;
  verificationRequired: boolean;
}

export interface StepRecord {
  id: string;
  taskId: string;
  ord: number;
  title: string;
  status: StepStatus;
  dependsOn: string[];
  note: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  projectId: string;
  runId: string | null;
  at: number;
  kind: string;
  summary: string;
  data: unknown;
}

export interface ApprovalRecord {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  kind: "edit" | "command" | "plan";
  payload: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  decidedAt: number | null;
}

export interface ChangeRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  path: string;
  kind: "added" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  beforeText: string | null;
  afterText: string | null;
  createdAt: number;
  status: "applied" | "reverted" | "conflict";
  note: string | null;
}

export interface VerificationRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  label: string;
  argv: string[];
  cwd: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "passed" | "failed" | "timed_out" | "cancelled" | "error" | "interrupted";
  exitCode: number | null;
  output: string;
  /** Fingerprint of the project's indexed files when the run started. */
  fingerprint: string | null;
}

export class WorkspaceStore {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  // ---- projects ----
  addProject(name: string, root: string, now: number): ProjectRecord {
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects (id, name, root, created_at, last_opened_at, settings) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, root, now, now, JSON.stringify(DEFAULT_PROJECT_SETTINGS));
    return this.getProject(id)!;
  }
  getProject(id: string): ProjectRecord | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }
  projectByRoot(root: string): ProjectRecord | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE root = ?").get(root) as Row | undefined;
    return r ? toProject(r) : null;
  }
  listProjects(): ProjectRecord[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC").all() as Row[]).map(toProject);
  }
  updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "root" | "lastOpenedAt" | "settings" | "notes">>) {
    const p = this.getProject(id);
    if (!p) throw new Error("That project is no longer in Lumen.");
    const n = { ...p, ...patch };
    this.db.prepare("UPDATE projects SET name = ?, root = ?, last_opened_at = ?, settings = ?, notes = ? WHERE id = ?").run(n.name, n.root, n.lastOpenedAt, JSON.stringify(n.settings), n.notes, id);
    return this.getProject(id)!;
  }
  /** Removes the reference and Lumen's records for it. Never touches files on disk. */
  removeProject(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes) > 0;
  }

  // ---- tasks ----
  addTask(projectId: string, t: { title: string; description: string; priority: number; tags: string[]; status: TaskStatus; verificationRequired: boolean }, now: number): TaskRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO tasks (id, project_id, title, description, status, priority, tags, created_at, updated_at, verification_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, t.title, t.description, t.status, t.priority, JSON.stringify(t.tags), now, now, t.verificationRequired ? 1 : 0);
    return this.getTask(projectId, id)!;
  }
  getTask(projectId: string, id: string): TaskRecord | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(id, projectId) as Row | undefined;
    return r ? toTask(r) : null;
  }
  listTasks(projectId: string): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, updated_at DESC").all(projectId) as Row[]).map(toTask);
  }
  /** Tasks left running/verifying (by any project) — used for crash recovery at startup. */
  activeTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status IN ('running','verifying')").all() as Row[]).map(toTask);
  }
  updateTask(projectId: string, id: string, patch: Partial<Omit<TaskRecord, "id" | "projectId" | "createdAt">>, now: number) {
    const t = this.getTask(projectId, id);
    if (!t) throw new Error("That task no longer exists.");
    const n = { ...t, ...patch, updatedAt: now };
    this.db
      .prepare("UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, tags = ?, reason = ?, updated_at = ?, checkpoint = ?, verification_required = ? WHERE id = ? AND project_id = ?")
      .run(
        n.title,
        n.description,
        n.status,
        n.priority,
        JSON.stringify(n.tags),
        n.reason,
        n.updatedAt,
        n.checkpoint ? JSON.stringify(n.checkpoint) : null,
        n.verificationRequired ? 1 : 0,
        id,
        projectId,
      );
    return this.getTask(projectId, id)!;
  }
  deleteTask(projectId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM tasks WHERE id = ? AND project_id = ?").run(id, projectId).changes) > 0;
  }

  // ---- steps (task ownership is checked through the task's project) ----
  replaceSteps(projectId: string, taskId: string, steps: { id?: string; title: string; dependsOn: string[]; status?: StepStatus }[]): StepRecord[] {
    if (!this.getTask(projectId, taskId)) throw new Error("That task no longer exists.");
    this.tx(() => {
      this.db.prepare("DELETE FROM task_steps WHERE task_id = ?").run(taskId);
      steps.forEach((s, i) =>
        this.db
          .prepare("INSERT INTO task_steps (id, task_id, ord, title, status, depends_on) VALUES (?, ?, ?, ?, ?, ?)")
          .run(s.id ?? randomUUID(), taskId, i, s.title, s.status ?? "todo", JSON.stringify(s.dependsOn)),
      );
    });
    return this.listSteps(projectId, taskId);
  }
  listSteps(projectId: string, taskId: string): StepRecord[] {
    if (!this.getTask(projectId, taskId)) return [];
    return (this.db.prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY ord").all(taskId) as Row[]).map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      ord: Number(r.ord),
      title: String(r.title),
      status: String(r.status) as StepStatus,
      dependsOn: json<string[]>(r.depends_on, []),
      note: r.note == null ? null : String(r.note),
    }));
  }
  updateStep(projectId: string, taskId: string, stepId: string, patch: { status?: StepStatus; note?: string | null; ord?: number }) {
    if (!this.getTask(projectId, taskId)) throw new Error("That task no longer exists.");
    const cur = this.listSteps(projectId, taskId).find((s) => s.id === stepId);
    if (!cur) throw new Error("That step no longer exists.");
    this.db
      .prepare("UPDATE task_steps SET status = ?, note = ?, ord = ? WHERE id = ? AND task_id = ?")
      .run(patch.status ?? cur.status, patch.note === undefined ? cur.note : patch.note, patch.ord ?? cur.ord, stepId, taskId);
  }

  // ---- events (evidence log; append-only) ----
  addEvent(e: Omit<TaskEvent, "id">) {
    this.db
      .prepare("INSERT INTO task_events (task_id, project_id, run_id, at, kind, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.taskId, e.projectId, e.runId, e.at, e.kind, e.summary.slice(0, 1000), e.data == null ? null : JSON.stringify(e.data).slice(0, 20_000));
  }
  listEvents(projectId: string, taskId: string, limit = 500): TaskEvent[] {
    return (this.db.prepare("SELECT * FROM task_events WHERE project_id = ? AND task_id = ? ORDER BY at, id LIMIT ?").all(projectId, taskId, limit) as Row[]).map(toEvent);
  }
  recentEvents(projectId: string, limit = 30): TaskEvent[] {
    return (this.db.prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(projectId, limit) as Row[]).map(toEvent);
  }

  // ---- approvals ----
  addApproval(a: Omit<ApprovalRecord, "id" | "status" | "decidedAt">): ApprovalRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO approvals (id, project_id, task_id, run_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, a.projectId, a.taskId, a.runId, a.kind, JSON.stringify(a.payload), a.createdAt);
    return this.getApproval(a.projectId, id)!;
  }
  getApproval(projectId: string, id: string): ApprovalRecord | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ? AND project_id = ?").get(id, projectId) as Row | undefined;
    return r ? toApproval(r) : null;
  }
  listApprovals(projectId: string, opts: { taskId?: string; status?: ApprovalRecord["status"] } = {}): ApprovalRecord[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[];
    return rows.map(toApproval).filter((a) => (!opts.taskId || a.taskId === opts.taskId) && (!opts.status || a.status === opts.status));
  }
  decideApproval(projectId: string, id: string, status: "approved" | "denied" | "expired", now: number) {
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'").run(status, now, id, projectId);
  }

  // ---- file changes ----
  addChange(c: Omit<ChangeRecord, "id" | "status" | "note">): ChangeRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO file_changes (id, project_id, task_id, run_id, path, kind, before_hash, after_hash, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, c.projectId, c.taskId, c.runId, c.path, c.kind, c.beforeHash, c.afterHash, c.beforeText, c.afterText, c.createdAt);
    return this.getChange(c.projectId, id)!;
  }
  getChange(projectId: string, id: string): ChangeRecord | null {
    const r = this.db.prepare("SELECT * FROM file_changes WHERE id = ? AND project_id = ?").get(id, projectId) as Row | undefined;
    return r ? toChange(r) : null;
  }
  listChanges(projectId: string, opts: { taskId?: string; limit?: number } = {}): ChangeRecord[] {
    const rows = opts.taskId
      ? (this.db.prepare("SELECT * FROM file_changes WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, opts.taskId, opts.limit ?? 500) as Row[])
      : (this.db.prepare("SELECT * FROM file_changes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, opts.limit ?? 500) as Row[]);
    return rows.map(toChange);
  }
  setChangeStatus(projectId: string, id: string, status: ChangeRecord["status"], note: string | null) {
    this.db.prepare("UPDATE file_changes SET status = ?, note = ? WHERE id = ? AND project_id = ?").run(status, note, id, projectId);
  }

  // ---- verifications ----
  addVerification(v: Omit<VerificationRecord, "id" | "finishedAt" | "status" | "exitCode" | "output">): VerificationRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO verifications (id, project_id, task_id, label, argv, cwd, started_at, status, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(id, v.projectId, v.taskId, v.label, JSON.stringify(v.argv), v.cwd, v.startedAt, v.fingerprint);
    return this.getVerification(v.projectId, id)!;
  }
  finishVerification(projectId: string, id: string, r: { status: VerificationRecord["status"]; exitCode: number | null; output: string; finishedAt: number }) {
    this.db.prepare("UPDATE verifications SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ? AND project_id = ?").run(r.status, r.exitCode, r.output, r.finishedAt, id, projectId);
  }
  getVerification(projectId: string, id: string): VerificationRecord | null {
    const r = this.db.prepare("SELECT * FROM verifications WHERE id = ? AND project_id = ?").get(id, projectId) as Row | undefined;
    return r ? toVerification(r) : null;
  }
  listVerifications(projectId: string, opts: { taskId?: string; limit?: number } = {}): VerificationRecord[] {
    const rows = opts.taskId
      ? (this.db.prepare("SELECT * FROM verifications WHERE project_id = ? AND task_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, opts.taskId, opts.limit ?? 100) as Row[])
      : (this.db.prepare("SELECT * FROM verifications WHERE project_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, opts.limit ?? 100) as Row[]);
    return rows.map(toVerification);
  }
  /** Runs left "running" by a crash: they did not finish; nothing about them is known. */
  interruptRunningVerifications(now: number): number {
    return Number(this.db.prepare("UPDATE verifications SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now).changes);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }
}

function toProject(r: Row): ProjectRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    root: String(r.root),
    createdAt: Number(r.created_at),
    lastOpenedAt: r.last_opened_at == null ? null : Number(r.last_opened_at),
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...json<Partial<ProjectSettings>>(r.settings, {}) },
    notes: String(r.notes ?? ""),
  };
}
function toTask(r: Row): TaskRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    description: String(r.description),
    status: String(r.status) as TaskStatus,
    priority: Number(r.priority),
    tags: json<string[]>(r.tags, []),
    reason: r.reason == null ? null : String(r.reason),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    checkpoint: json<Checkpoint | null>(r.checkpoint, null),
    verificationRequired: Number(r.verification_required) === 1,
  };
}
function toEvent(r: Row): TaskEvent {
  return {
    id: Number(r.id),
    taskId: String(r.task_id),
    projectId: String(r.project_id),
    runId: r.run_id == null ? null : String(r.run_id),
    at: Number(r.at),
    kind: String(r.kind),
    summary: String(r.summary),
    data: json(r.data, null),
  };
}
function toApproval(r: Row): ApprovalRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: String(r.task_id),
    runId: String(r.run_id),
    kind: String(r.kind) as ApprovalRecord["kind"],
    payload: json(r.payload, null),
    status: String(r.status) as ApprovalRecord["status"],
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  };
}
function toChange(r: Row): ChangeRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: r.task_id == null ? null : String(r.task_id),
    runId: r.run_id == null ? null : String(r.run_id),
    path: String(r.path),
    kind: String(r.kind) as ChangeRecord["kind"],
    beforeHash: r.before_hash == null ? null : String(r.before_hash),
    afterHash: r.after_hash == null ? null : String(r.after_hash),
    beforeText: r.before_text == null ? null : String(r.before_text),
    afterText: r.after_text == null ? null : String(r.after_text),
    createdAt: Number(r.created_at),
    status: String(r.status) as ChangeRecord["status"],
    note: r.note == null ? null : String(r.note),
  };
}
function toVerification(r: Row): VerificationRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: r.task_id == null ? null : String(r.task_id),
    label: String(r.label),
    argv: json<string[]>(r.argv, []),
    cwd: String(r.cwd),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    status: String(r.status) as VerificationRecord["status"],
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    output: String(r.output ?? ""),
    fingerprint: r.fingerprint == null ? null : String(r.fingerprint),
  };
}
