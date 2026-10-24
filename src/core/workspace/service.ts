// Project workspace: projects, durable tasks and plans, the approval-gated agent loop, the traced
// change ledger with conflict-safe revert, verification runs, and recovery after a restart.
//
// Invariants (tested in src/test/workspace.test.ts):
// - Every operation takes an explicit projectId; file access goes through boundary.ts against the
//   project's root as it is NOW; one run per task and one writer per file at a time.
// - The agent's file writes and unapproved commands require a recorded user approval for that
//   exact payload. Approvals are re-checked when applied (file unchanged since the proposal).
// - A task reaches "completed" only from "verifying" and only via completionBlocker() == null.
// - A verification result is "current" only while the project's indexed files still match the
//   fingerprint taken when it ran.
// - Revert restores the before-state only if the file still matches the agent's after-state;
//   otherwise it refuses and reports a conflict. Nothing ever restores a whole-project snapshot.
// - Removing a project deletes Lumen's records about it, never files.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "../storage/db";
import type { AIProvider } from "../providers/types";
import { CancelledError, ProviderError } from "../providers/types";
import { writeFileAtomic } from "../fsutil";
import { redactCredentials } from "../credentials";
import { BoundaryError, isProtected, realRoot, resolveInRoot, rootStatus, type RootStatus } from "./boundary";
import { fingerprint, ProjectIndex } from "./indexer";
import { runCommand, validateArgv, type RunResult } from "./runner";
import { diffLines, type FileDiff } from "./diff";
import { gitStatus, type GitStatus } from "./git";
import { ACTION_JSON_SCHEMA, AGENT_SYSTEM, buildAgentPrompt, describeAction, parseAction, type AgentAction } from "./agent";
import { ACTIVE, completionBlocker, readySteps, transition, TransitionError, validateDependencies, validateOrder, type StepStatus, type TaskStatus } from "./tasks";
import {
  DEFAULT_PROJECT_SETTINGS,
  WorkspaceStore,
  type ApprovalRecord,
  type ChangeRecord,
  type Checkpoint,
  type ProjectRecord,
  type ProjectSettings,
  type StepRecord,
  type TaskRecord,
  type VerificationRecord,
} from "./store";

export type WorkspaceEvent =
  | { type: "projects-changed" }
  | { type: "task-changed"; projectId: string; taskId: string }
  | { type: "run-progress"; projectId: string; taskId: string; runId: string; message: string }
  | { type: "verification"; projectId: string; verification: VerificationRecord };

export interface WorkspaceDeps {
  store: Store;
  now?: () => number;
  /** The provider for agent runs (the user's configured provider), or null if none is configured. */
  provider: () => AIProvider | null;
  model: () => string;
  maxTokens: () => number;
  emit: (e: WorkspaceEvent) => void;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
  /** Usage limits: throws when a call would exceed them. */
  checkUsage?: (model: string, inputTokens: number, maxOutputTokens: number) => void;
  recordUsage?: (model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, ok: boolean) => void;
}

export interface ProjectView extends ProjectRecord {
  status: RootStatus;
  taskCounts: Record<string, number>;
}

/** Hard limits for one agent run (a run stops and the task waits for the user when it hits them). */
export const RUN_LIMITS = { maxActions: 25, maxReadBytes: 200_000, maxObservationChars: 12_000, maxFileBytesForEdit: 400_000 };

const MAX_PROJECTS = 50;
const MAX_TEXT_FOR_LEDGER = 2_000_000;

interface ActiveRun {
  runId: string;
  ctrl: AbortController;
  promise: Promise<void>;
}

export class WorkspaceService {
  readonly db: WorkspaceStore;
  private readonly now: () => number;
  private indexes = new Map<string, ProjectIndex>();
  private runs = new Map<string, ActiveRun>(); // by taskId
  private verifyRuns = new Map<string, AbortController>(); // by verification id
  /** Files with an in-flight write, by "projectId:rel" — a second writer waits for none, it fails. */
  private writing = new Set<string>();
  activeProjectId: string | null = null;

  constructor(private readonly d: WorkspaceDeps) {
    this.db = new WorkspaceStore(d.store);
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── projects ─────────────────────────────

  listProjects(): ProjectView[] {
    return this.db.listProjects().map((p) => this.view(p));
  }

  private view(p: ProjectRecord): ProjectView {
    const counts: Record<string, number> = {};
    for (const t of this.db.listTasks(p.id)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return { ...p, status: rootStatus(p.root), taskCounts: counts };
  }

  project(projectId: string): ProjectRecord {
    const p = this.db.getProject(projectId);
    if (!p) throw new Error("That project is no longer in Lumen.");
    return p;
  }

  /** Root for an operation, checked now. Throws a readable error if it is unavailable. */
  private root(projectId: string): string {
    return realRoot(this.project(projectId).root);
  }

  addProject(root: string, name?: string): ProjectView {
    if (!path.isAbsolute(root)) throw new Error("Choose a folder.");
    const st = rootStatus(root);
    if (st !== "available") throw new Error(st === "missing" ? "That folder does not exist." : st === "not_directory" ? "That is a file, not a folder." : "Lumen can't read that folder.");
    const real = realRoot(root);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (real === path.parse(real).root || (home && path.resolve(real) === path.resolve(home))) throw new Error("Choose a project folder, not your whole disk or home folder.");
    const existing = this.db.projectByRoot(real);
    if (existing) return this.view(this.db.updateProject(existing.id, { lastOpenedAt: this.now() }));
    // Nested projects would let one project's operations reach into another's files.
    for (const p of this.db.listProjects()) {
      const a = path.relative(p.root, real);
      const b = path.relative(real, p.root);
      if (!a.startsWith("..") && !path.isAbsolute(a)) throw new Error(`That folder is inside the project “${p.name}”.`);
      if (!b.startsWith("..") && !path.isAbsolute(b)) throw new Error(`That folder contains the project “${p.name}”.`);
    }
    if (this.db.listProjects().length >= MAX_PROJECTS) throw new Error(`Lumen keeps up to ${MAX_PROJECTS} projects. Remove one first.`);
    const p = this.db.addProject((name?.trim() || path.basename(real)).slice(0, 120), real, this.now());
    this.d.emit({ type: "projects-changed" });
    return this.view(p);
  }

  openProject(projectId: string): ProjectView {
    const p = this.db.updateProject(projectId, { lastOpenedAt: this.now() });
    this.activeProjectId = projectId;
    this.d.emit({ type: "projects-changed" });
    return this.view(p);
  }

  renameProject(projectId: string, name: string): ProjectView {
    const n = name.trim();
    if (!n || n.length > 120) throw new Error("Give the project a name (up to 120 characters).");
    const p = this.db.updateProject(projectId, { name: n });
    this.d.emit({ type: "projects-changed" });
    return this.view(p);
  }

  /** Point a moved project at its new folder. Records stay; paths in them are relative. */
  relocateProject(projectId: string, root: string): ProjectView {
    if (rootStatus(root) !== "available") throw new Error("That folder is not available.");
    const real = realRoot(root);
    const clash = this.db.projectByRoot(real);
    if (clash && clash.id !== projectId) throw new Error(`That folder is already the project “${clash.name}”.`);
    this.indexes.delete(projectId);
    const p = this.db.updateProject(projectId, { root: real });
    this.d.emit({ type: "projects-changed" });
    return this.view(p);
  }

  updateProjectSettings(projectId: string, patch: Partial<ProjectSettings> & { notes?: string }): ProjectRecord {
    const p = this.project(projectId);
    const next: ProjectSettings = { ...p.settings };
    if (patch.excludes)
      next.excludes = patch.excludes
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 200);
    if (patch.verifyCommands) next.verifyCommands = patch.verifyCommands.slice(0, 20).map((c) => ({ label: c.label.trim().slice(0, 80) || c.argv.join(" "), argv: validateArgv(c.argv) }));
    if (patch.allowedCommands) next.allowedCommands = patch.allowedCommands.slice(0, 50).map((a) => validateArgv(a));
    if (patch.editPolicy) next.editPolicy = patch.editPolicy;
    if (patch.commandTimeoutSec != null) next.commandTimeoutSec = Math.max(5, Math.min(3600, Math.round(patch.commandTimeoutSec)));
    if (patch.model !== undefined) next.model = patch.model?.trim() || null;
    const out = this.db.updateProject(projectId, { settings: next, ...(patch.notes !== undefined ? { notes: redactCredentials(patch.notes).slice(0, 20_000) } : {}) });
    if (patch.excludes) this.indexes.delete(projectId);
    return out;
  }

  /** Remove the project from Lumen (and Lumen's records about it). Files on disk are untouched. */
  removeProject(projectId: string) {
    for (const t of this.db.listTasks(projectId)) this.runs.get(t.id)?.ctrl.abort();
    this.indexes.delete(projectId);
    if (!this.db.removeProject(projectId)) throw new Error("That project is no longer in Lumen.");
    if (this.activeProjectId === projectId) this.activeProjectId = null;
    this.d.emit({ type: "projects-changed" });
  }

  // ───────────────────────────── index & files ─────────────────────────────

  index(projectId: string, refresh = false): ProjectIndex {
    const p = this.project(projectId);
    let ix = this.indexes.get(projectId);
    if (!ix) {
      ix = new ProjectIndex(realRoot(p.root), p.settings.excludes, undefined, this.now);
      this.indexes.set(projectId, ix);
      refresh = true;
    }
    if (refresh) ix.refresh();
    return ix;
  }

  search(projectId: string, query: string) {
    return this.index(projectId, true).search(query);
  }

  /** Read a text file for the user or the agent. Protected and binary files are refused. */
  readFile(projectId: string, rel: string, maxBytes = RUN_LIMITS.maxReadBytes): { rel: string; text: string; truncated: boolean; hash: string } {
    const r = resolveInRoot(this.project(projectId).root, rel);
    if (!r.exists) throw new BoundaryError(`${r.rel} does not exist.`, "invalid_path");
    const st = fs.statSync(r.abs);
    if (!st.isFile()) throw new BoundaryError(`${r.rel} is not a file.`, "invalid_path");
    const buf = fs.readFileSync(r.abs);
    if (buf.subarray(0, 8000).includes(0)) throw new BoundaryError(`${r.rel} is a binary file.`, "invalid_path");
    const text = buf.toString("utf8");
    return { rel: r.rel, text: text.slice(0, maxBytes), truncated: text.length > maxBytes, hash: fingerprint(buf) };
  }

  async git(projectId: string): Promise<GitStatus> {
    return gitStatus(this.project(projectId).root);
  }

  // ───────────────────────────── tasks & plans ─────────────────────────────

  createTask(projectId: string, input: { title?: string; description: string; priority?: number; tags?: string[]; verificationRequired?: boolean }): TaskRecord {
    this.project(projectId);
    const description = redactCredentials(input.description.trim()).slice(0, 20_000);
    if (!description && !input.title?.trim()) throw new Error("Describe the task.");
    const title = (input.title?.trim() || description.split("\n")[0]!).slice(0, 200);
    const t = this.db.addTask(
      projectId,
      {
        title,
        description,
        priority: Math.max(0, Math.min(4, input.priority ?? 2)),
        tags: (input.tags ?? []).slice(0, 20).map((x) => x.slice(0, 40)),
        status: "ready",
        verificationRequired: input.verificationRequired ?? true,
      },
      this.now(),
    );
    this.event(t, null, "created", "Task created");
    return t;
  }

  task(projectId: string, taskId: string): TaskRecord {
    const t = this.db.getTask(projectId, taskId);
    if (!t) throw new Error("That task no longer exists.");
    return t;
  }

  editTask(projectId: string, taskId: string, patch: { title?: string; description?: string; priority?: number; tags?: string[]; verificationRequired?: boolean }): TaskRecord {
    const t = this.task(projectId, taskId);
    const out = this.db.updateTask(
      projectId,
      taskId,
      {
        title: patch.title?.trim().slice(0, 200) || t.title,
        description: patch.description !== undefined ? redactCredentials(patch.description).slice(0, 20_000) : t.description,
        priority: patch.priority ?? t.priority,
        tags: patch.tags ?? t.tags,
        verificationRequired: patch.verificationRequired ?? t.verificationRequired,
      },
      this.now(),
    );
    this.changed(out);
    return out;
  }

  setStatus(projectId: string, taskId: string, to: TaskStatus, reason: string | null = null): TaskRecord {
    const t = this.task(projectId, taskId);
    if (to === "completed") {
      const blocker = this.completionBlockerFor(t);
      if (blocker) throw new TransitionError(`Not complete: ${blocker}`);
    }
    transition(t.status, to);
    // Persist the transition and its evidence record together.
    const out = this.db.transaction(() => {
      const u = this.db.updateTask(projectId, taskId, { status: to, reason }, this.now());
      this.event(u, this.runs.get(taskId)?.runId ?? null, "status", `${t.status} → ${to}${reason ? `: ${reason}` : ""}`);
      return u;
    });
    this.changed(out);
    return out;
  }

  steps(projectId: string, taskId: string): StepRecord[] {
    return this.db.listSteps(projectId, taskId);
  }

  /** Replace the plan. `dependsOn` refers to step indexes in the given list. */
  setPlan(projectId: string, taskId: string, steps: { title: string; dependsOn: number[] }[]): StepRecord[] {
    const withIds = steps.map((s) => ({ id: randomUUID(), title: s.title.trim().slice(0, 300), dependsOn: s.dependsOn }));
    const resolved = withIds.map((s) => ({ ...s, dependsOn: s.dependsOn.map((i) => withIds[i]?.id ?? "missing") }));
    validateDependencies(resolved);
    const out = this.db.replaceSteps(projectId, taskId, resolved);
    this.event(this.task(projectId, taskId), this.runs.get(taskId)?.runId ?? null, "plan", `Plan set (${out.length} steps)`);
    return out;
  }

  setStep(projectId: string, taskId: string, stepId: string, status: StepStatus, note?: string) {
    const steps = this.steps(projectId, taskId);
    const s = steps.find((x) => x.id === stepId);
    if (!s) throw new Error("That step no longer exists.");
    if ((status === "doing" || status === "done") && !readySteps(steps.map((x) => (x.id === stepId ? { ...x, status: "todo" as const } : x))).some((x) => x.id === stepId) && s.status === "todo")
      throw new TransitionError("That step depends on steps that are not done yet.");
    this.db.updateStep(projectId, taskId, stepId, { status, note: note ?? s.note });
    this.changed(this.task(projectId, taskId));
  }

  reorderSteps(projectId: string, taskId: string, order: string[]) {
    const steps = this.steps(projectId, taskId);
    validateOrder(order, steps);
    order.forEach((id, i) => this.db.updateStep(projectId, taskId, id, { ord: i }));
    this.changed(this.task(projectId, taskId));
  }

  events(projectId: string, taskId: string) {
    return this.db.listEvents(projectId, taskId);
  }

  private event(t: TaskRecord, runId: string | null, kind: string, summary: string, data?: unknown) {
    this.db.addEvent({ taskId: t.id, projectId: t.projectId, runId, at: this.now(), kind, summary: redactCredentials(summary), data: data ?? null });
  }

  private changed(t: TaskRecord) {
    this.d.emit({ type: "task-changed", projectId: t.projectId, taskId: t.id });
  }

  // ───────────────────────────── evidence & completion ─────────────────────────────

  /** Whether a verification still describes the project as it is now. */
  isCurrent(v: VerificationRecord): boolean {
    if (!v.fingerprint || v.status === "running") return false;
    try {
      return this.index(v.projectId, true).treeFingerprint() === v.fingerprint;
    } catch {
      return false;
    }
  }

  completionBlockerFor(t: TaskRecord): string | null {
    const latest = this.db.listVerifications(t.projectId, { taskId: t.id, limit: 1 })[0] ?? null;
    return completionBlocker({
      verificationRequired: t.verificationRequired,
      latest: latest ? { status: latest.status, current: this.isCurrent(latest) } : null,
      openSteps: this.steps(t.projectId, t.id).filter((s) => s.status !== "done" && s.status !== "skipped").length,
      pendingApprovals: this.db.listApprovals(t.projectId, { taskId: t.id, status: "pending" }).length,
    });
  }

  /** Move a verifying task to completed or back to running/failed according to the evidence. */
  evaluateCompletion(projectId: string, taskId: string): TaskRecord {
    const t = this.task(projectId, taskId);
    if (t.status !== "verifying") return t;
    const blocker = this.completionBlockerFor(t);
    if (!blocker) return this.setStatus(projectId, taskId, "completed", null);
    const latest = this.db.listVerifications(projectId, { taskId, limit: 1 })[0];
    if (latest && this.isCurrent(latest) && latest.status !== "passed" && latest.status !== "running")
      return this.setStatus(projectId, taskId, "failed", `Verification ${latest.status.replace("_", " ")}: ${latest.label}`);
    return this.db.updateTask(projectId, taskId, { reason: blocker }, this.now());
  }

  // ───────────────────────────── verification ─────────────────────────────

  /**
   * Run a verification command. Allowed only if the exact argv is one of the project's configured
   * verify commands, or `approvalId` is an approved command approval for exactly this argv.
   */
  async verify(projectId: string, input: { argv: string[]; label?: string; taskId?: string | null; approvalId?: string }): Promise<VerificationRecord> {
    const p = this.project(projectId);
    const argv = validateArgv(input.argv);
    if (!this.commandAllowed(p, argv, input.approvalId, input.taskId ?? null))
      throw new Error("That command is not approved for this project. Add it to the project's verification commands, or approve it when the agent asks.");
    const root = realRoot(p.root);
    const fp = this.index(projectId, true).treeFingerprint();
    const v = this.db.addVerification({ projectId, taskId: input.taskId ?? null, label: input.label ?? argv.join(" "), argv, cwd: root, startedAt: this.now(), fingerprint: fp });
    const ctrl = new AbortController();
    this.verifyRuns.set(v.id, ctrl);
    this.d.emit({ type: "verification", projectId, verification: v });
    let r: RunResult;
    try {
      r = await runCommand({ root, argv, timeoutMs: p.settings.commandTimeoutSec * 1000, signal: ctrl.signal, now: this.now });
    } finally {
      this.verifyRuns.delete(v.id);
    }
    const output = redactCredentials(r.output + (r.truncated ? "\n[output truncated]" : "") + (r.error ? `\n${r.error}` : ""));
    this.db.finishVerification(projectId, v.id, { status: r.status, exitCode: r.exitCode, output, finishedAt: r.finishedAt });
    const done = this.db.getVerification(projectId, v.id)!;
    if (done.taskId) {
      const t = this.db.getTask(projectId, done.taskId);
      if (t) this.event(t, this.runs.get(t.id)?.runId ?? null, "verification", `${done.label}: ${done.status}${done.exitCode != null ? ` (exit ${done.exitCode})` : ""}`, { verificationId: done.id });
    }
    this.d.emit({ type: "verification", projectId, verification: done });
    return done;
  }

  cancelVerification(projectId: string, id: string): boolean {
    if (!this.db.getVerification(projectId, id)) return false;
    const c = this.verifyRuns.get(id);
    c?.abort();
    return !!c;
  }

  private commandAllowed(p: ProjectRecord, argv: string[], approvalId: string | undefined, taskId: string | null): boolean {
    const same = (a: string[]) => a.length === argv.length && a.every((x, i) => x === argv[i]);
    if (p.settings.verifyCommands.some((c) => same(c.argv)) || p.settings.allowedCommands.some(same)) return true;
    if (!approvalId) return false;
    const a = this.db.getApproval(p.id, approvalId);
    return !!a && a.kind === "command" && a.status === "approved" && (taskId == null || a.taskId === taskId) && same((a.payload as { argv: string[] }).argv);
  }

  // ───────────────────────────── changes ─────────────────────────────

  changes(projectId: string, taskId?: string) {
    return this.db.listChanges(projectId, { taskId }).map((c) => ({ ...c, beforeText: undefined, afterText: undefined, current: this.changeState(c) }));
  }

  /** How the file compares to this change now: still as the agent left it, edited since, or gone. */
  changeState(c: ChangeRecord): "as_applied" | "modified_since" | "missing" | "unavailable" {
    try {
      const r = resolveInRoot(this.project(c.projectId).root, c.path);
      if (!r.exists) return c.kind === "deleted" ? "as_applied" : "missing";
      return fingerprint(fs.readFileSync(r.abs)) === c.afterHash ? "as_applied" : "modified_since";
    } catch {
      return "unavailable";
    }
  }

  changeDiff(projectId: string, changeId: string): { change: Omit<ChangeRecord, "beforeText" | "afterText">; diff: FileDiff } {
    const c = this.db.getChange(projectId, changeId);
    if (!c) throw new Error("That change is no longer recorded.");
    const { beforeText, afterText, ...rest } = c;
    return { change: rest, diff: diffLines(beforeText ?? "", afterText ?? "") };
  }

  /**
   * Revert one agent change: only if the file is exactly as the agent left it. If the user (or
   * another task) edited it since, refuse and say so — never overwrite newer work.
   */
  revertChange(projectId: string, changeId: string): ChangeRecord {
    const c = this.db.getChange(projectId, changeId);
    if (!c) throw new Error("That change is no longer recorded.");
    if (c.status === "reverted") throw new Error("That change was already reverted.");
    const r = resolveInRoot(this.project(projectId).root, c.path);
    const key = `${projectId}:${r.rel}`;
    if (this.writing.has(key)) throw new Error(`${r.rel} is being written right now. Try again in a moment.`);
    const nowHash = r.exists ? fingerprint(fs.readFileSync(r.abs)) : null;
    if (nowHash !== c.afterHash) {
      this.db.setChangeStatus(projectId, changeId, "conflict", "The file was changed after the agent's edit, so it was not reverted.");
      throw new Error(`${r.rel} has changed since the agent edited it, so Lumen did not revert it (your newer changes are kept). Compare the diff and undo the agent's part by hand if needed.`);
    }
    this.writing.add(key);
    try {
      if (c.kind === "added") fs.rmSync(r.abs);
      else {
        fs.mkdirSync(path.dirname(r.abs), { recursive: true });
        writeFileAtomic(r.abs, c.beforeText ?? "", modeOf(r.abs));
      }
    } finally {
      this.writing.delete(key);
    }
    this.db.setChangeStatus(projectId, changeId, "reverted", null);
    if (c.taskId) {
      const t = this.db.getTask(projectId, c.taskId);
      if (t) this.event(t, null, "revert", `Reverted ${c.kind} of ${c.path}`);
    }
    this.indexes.get(projectId)?.refresh();
    return this.db.getChange(projectId, changeId)!;
  }

  /** Apply an approved edit. The file must still be as it was when the edit was proposed. */
  private applyEdit(t: TaskRecord, runId: string | null, payload: { path: string; content: string; baseHash: string | null }): ChangeRecord {
    const r = resolveInRoot(this.project(t.projectId).root, payload.path);
    const key = `${t.projectId}:${r.rel}`;
    if (this.writing.has(key)) throw new Error(`${r.rel} is being written by another task.`);
    const before = r.exists ? fs.readFileSync(r.abs) : null;
    const beforeHash = before ? fingerprint(before) : null;
    if (beforeHash !== payload.baseHash)
      throw new Error(`${r.rel} changed after the edit was proposed (by you or another task), so it was not applied. Ask the agent to re-read the file and propose it again.`);
    this.writing.add(key);
    try {
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      writeFileAtomic(r.abs, payload.content, r.exists ? modeOf(r.abs) : 0o644);
    } finally {
      this.writing.delete(key);
    }
    const beforeText = before ? before.toString("utf8") : null;
    const ledger = (s: string | null) => (s != null && s.length <= MAX_TEXT_FOR_LEDGER ? s : null);
    const change = this.db.addChange({
      projectId: t.projectId,
      taskId: t.id,
      runId,
      path: r.rel,
      kind: before ? "modified" : "added",
      beforeHash,
      afterHash: fingerprint(Buffer.from(payload.content)),
      beforeText: ledger(beforeText),
      afterText: ledger(payload.content),
      createdAt: this.now(),
    });
    this.event(t, runId, "change", `${change.kind} ${change.path}`, { changeId: change.id });
    this.indexes.get(t.projectId)?.refresh();
    return change;
  }

  // ───────────────────────────── approvals ─────────────────────────────

  approvals(projectId: string, opts: { taskId?: string; status?: ApprovalRecord["status"] } = {}) {
    return this.db.listApprovals(projectId, opts).map((a) => {
      if (a.kind !== "edit") return { ...a, diff: null };
      const p = a.payload as { path: string; content: string; baseText: string | null };
      return { ...a, payload: { path: p.path, reason: (a.payload as { reason?: string }).reason ?? "" }, diff: diffLines(p.baseText ?? "", p.content) };
    });
  }

  /**
   * Decide an approval. Approving an edit applies it now (if the file is unchanged since the
   * proposal); approving a command runs it as a verification. The task then continues.
   */
  async decide(projectId: string, approvalId: string, decision: "approved" | "denied"): Promise<ApprovalRecord> {
    const a = this.db.getApproval(projectId, approvalId);
    if (!a) throw new Error("That approval request no longer exists.");
    if (a.status !== "pending") throw new Error(`That request was already ${a.status}.`);
    const t = this.task(projectId, a.taskId);
    this.db.decideApproval(projectId, approvalId, decision, this.now());
    this.event(t, a.runId, "approval", `${a.kind} ${decision}`, { approvalId });
    if (decision === "denied") {
      this.addObservation(
        t,
        `The user DENIED your ${a.kind === "edit" ? `edit of ${(a.payload as { path: string }).path}` : `command ${JSON.stringify((a.payload as { argv: string[] }).argv)}`}. Do not retry it unchanged.`,
      );
    } else if (a.kind === "edit") {
      try {
        const c = this.applyEdit(t, a.runId, a.payload as { path: string; content: string; baseHash: string | null });
        this.addObservation(t, `The user approved your edit. ${c.path} was written (${c.kind}).`);
      } catch (err) {
        this.addObservation(t, `Your approved edit could NOT be applied: ${(err as Error).message}`);
        this.event(t, a.runId, "error", (err as Error).message);
      }
    } else if (a.kind === "command") {
      const argv = (a.payload as { argv: string[] }).argv;
      const v = await this.verify(projectId, { argv, taskId: t.id, approvalId, label: argv.join(" ") });
      this.addObservation(t, commandObservation(v));
    }
    // Continue the task if it was waiting for this decision and nothing else is pending.
    const fresh = this.task(projectId, t.id);
    if (fresh.status === "waiting_approval" && !this.db.listApprovals(projectId, { taskId: t.id, status: "pending" }).length) {
      this.setStatus(projectId, t.id, "running", null);
      this.startRun(projectId, t.id, { continuing: true });
    }
    return this.db.getApproval(projectId, approvalId)!;
  }

  // ───────────────────────────── agent runs ─────────────────────────────

  isRunning(taskId: string) {
    return this.runs.has(taskId);
  }

  /** Start (or resume) the agent on a task. Returns immediately; progress is emitted and persisted. */
  start(projectId: string, taskId: string): { runId: string } {
    const t = this.task(projectId, taskId);
    if (this.runs.has(taskId)) throw new Error("This task is already running.");
    if (!this.d.provider()) throw new Error("No AI provider is configured. Set one up in Settings → AI provider.");
    this.root(projectId); // fail now if the folder is gone
    // Resume from any resumable state through the state machine (blocked/failed/cancelled → ready → running).
    if (["blocked", "failed", "cancelled", "completed", "backlog"].includes(t.status)) this.setStatus(projectId, taskId, "ready", null);
    const cur = this.task(projectId, taskId);
    if (cur.status === "waiting_approval") throw new Error("This task is waiting for your approval. Approve or reject the pending request first.");
    if (cur.status === "verifying") throw new Error("This task is being verified.");
    if (cur.status !== "running") this.setStatus(projectId, taskId, "running", null);
    return this.startRun(projectId, taskId, { continuing: !!cur.checkpoint?.runId });
  }

  private startRun(projectId: string, taskId: string, opts: { continuing: boolean }): { runId: string } {
    const prev = this.task(projectId, taskId).checkpoint;
    const runId = opts.continuing && prev?.runId ? prev.runId : randomUUID();
    const ctrl = new AbortController();
    const promise = this.loop(projectId, taskId, runId, ctrl.signal).finally(() => {
      if (this.runs.get(taskId)?.runId === runId) this.runs.delete(taskId);
    });
    this.runs.set(taskId, { runId, ctrl, promise });
    return { runId };
  }

  /** Wait for a task's run to stop (tests and shutdown). */
  async settle(taskId: string) {
    await this.runs.get(taskId)?.promise;
  }

  pause(projectId: string, taskId: string) {
    this.runs.get(taskId)?.ctrl.abort("pause");
    const t = this.task(projectId, taskId);
    if (t.status === "running" || t.status === "waiting_approval") this.setStatus(projectId, taskId, "paused", "Paused by you");
  }

  cancel(projectId: string, taskId: string) {
    this.runs.get(taskId)?.ctrl.abort("cancel");
    for (const a of this.db.listApprovals(projectId, { taskId, status: "pending" })) this.db.decideApproval(projectId, a.id, "expired", this.now());
    const t = this.task(projectId, taskId);
    if (t.status !== "cancelled" && t.status !== "completed") this.setStatus(projectId, taskId, "cancelled", "Cancelled by you");
  }

  /** Retry a failed/blocked/cancelled task: back to ready, previous evidence kept. */
  retry(projectId: string, taskId: string) {
    this.setStatus(projectId, taskId, "ready", null);
  }

  private turns = new Map<string, { action: string; observation: string }[]>();
  private addObservation(t: TaskRecord, text: string) {
    const list = this.turns.get(t.id) ?? this.loadTurns(t);
    list.push({ action: "(Lumen)", observation: text.slice(0, RUN_LIMITS.maxObservationChars) });
    this.turns.set(t.id, list);
    this.event(t, null, "observation", text.slice(0, 300), { text: text.slice(0, RUN_LIMITS.maxObservationChars) });
  }

  /** Rebuild the run transcript from the persisted evidence log (after a restart). */
  private loadTurns(t: TaskRecord): { action: string; observation: string }[] {
    return this.db
      .listEvents(t.projectId, t.id)
      .filter((e) => e.kind === "action" || e.kind === "observation")
      .slice(-40)
      .map((e) => {
        const d = e.data as { action?: string; observation?: string; text?: string } | null;
        return e.kind === "action" ? { action: d?.action ?? e.summary, observation: d?.observation ?? "" } : { action: "(Lumen)", observation: d?.text ?? e.summary };
      });
  }

  private async loop(projectId: string, taskId: string, runId: string, signal: AbortSignal) {
    const provider = this.d.provider();
    let t = this.task(projectId, taskId);
    if (!provider) return void this.fail(t, "No AI provider is configured.");
    const turns = this.turns.get(taskId) ?? this.loadTurns(t);
    this.turns.set(taskId, turns);
    const recovery = this.recoverySummary(projectId, taskId);
    this.event(t, runId, "run", "Agent run started");
    for (let n = 0; n < RUN_LIMITS.maxActions; n++) {
      if (signal.aborted) return;
      t = this.task(projectId, taskId);
      if (t.status !== "running") return;
      let p: ProjectRecord;
      try {
        p = this.project(projectId);
        realRoot(p.root);
      } catch (err) {
        return void this.block(t, (err as Error).message);
      }
      const steps = this.steps(projectId, taskId);
      const prompt = buildAgentPrompt({
        projectName: p.name,
        task: { title: t.title, description: t.description, status: t.status },
        steps: steps.map((s) => ({ title: s.title, status: s.status, dependsOn: s.dependsOn.map((d) => steps.findIndex((x) => x.id === d)), note: s.note })),
        recovery: n === 0 ? recovery.text : null,
        projectNotes: p.notes,
        verifyCommands: p.settings.verifyCommands.map((c) => JSON.stringify(c.argv)),
        turns,
      });
      const model = p.settings.model ?? this.d.model();
      let text: string;
      try {
        this.d.checkUsage?.(model, Math.ceil((AGENT_SYSTEM.length + prompt.length) / 3.5), this.d.maxTokens());
        this.d.emit({ type: "run-progress", projectId, taskId, runId, message: "Thinking…" });
        const res = await provider.generate(
          {
            model,
            system: [{ text: AGENT_SYSTEM, cache: true }],
            messages: [{ role: "user", content: prompt }],
            maxTokens: this.d.maxTokens(),
            effort: "medium",
            timeoutMs: 120_000,
            jsonSchema: ACTION_JSON_SCHEMA,
          },
          signal,
        );
        this.d.recordUsage?.(res.model, res.usage, true);
        text = res.text;
      } catch (err) {
        if (err instanceof CancelledError || signal.aborted) return;
        const pe = err instanceof ProviderError ? err : null;
        return void this.block(t, `The AI provider request failed${pe ? ` (${pe.code})` : ""}: ${(err as Error).message}`);
      }
      const parsed = parseAction(text);
      if (!parsed.ok) {
        turns.push({ action: "(invalid response)", observation: `${parsed.error} Reply with one JSON action.` });
        this.event(t, runId, "invalid", parsed.error);
        continue;
      }
      const desc = describeAction(parsed.action);
      this.d.emit({ type: "run-progress", projectId, taskId, runId, message: desc });
      const outcome = await this.perform(t, runId, parsed.action, signal);
      turns.push({ action: desc, observation: outcome.observation });
      this.event(t, runId, "action", `${desc}${outcome.summary ? ` → ${outcome.summary}` : ""}`, {
        action: desc,
        thought: parsed.thought.slice(0, 500),
        observation: outcome.observation.slice(0, RUN_LIMITS.maxObservationChars),
      });
      this.checkpoint(projectId, taskId, runId, parsed.action.type === "finish" ? (parsed.action.findings ?? []) : null);
      if (outcome.stop) return;
    }
    this.block(this.task(projectId, taskId), `Stopped after ${RUN_LIMITS.maxActions} actions without finishing. Review the history, then resume or refine the task.`);
  }

  private async perform(t: TaskRecord, runId: string, a: AgentAction, signal: AbortSignal): Promise<{ observation: string; summary?: string; stop?: boolean }> {
    const pid = t.projectId;
    const p = this.project(pid);
    try {
      switch (a.type) {
        case "read_file": {
          const f = this.readFile(pid, a.path);
          this.rememberFile(t, f.rel, f.hash);
          return { observation: `${f.rel}${f.truncated ? " (truncated)" : ""}:\n${numbered(f.text)}`, summary: `${f.text.length} chars` };
        }
        case "search": {
          const hits = this.search(pid, a.query).slice(0, 40);
          return { observation: hits.length ? hits.map((h) => `${h.rel}${h.line ? `:${h.line}` : ""} [${h.kind}] ${h.text}`).join("\n") : "No matches.", summary: `${hits.length} matches` };
        }
        case "list_files": {
          const files = this.index(pid, true)
            .list()
            .filter((f) => !a.prefix || f.rel.startsWith(a.prefix))
            .slice(0, 400);
          return { observation: files.map((f) => f.rel).join("\n") || "No files.", summary: `${files.length} files` };
        }
        case "update_plan":
          this.setPlan(pid, t.id, a.steps);
          return { observation: "Plan saved.", summary: `${a.steps.length} steps` };
        case "set_step": {
          const s = this.steps(pid, t.id)[a.stepIndex];
          if (!s) return { observation: `There is no step ${a.stepIndex}.` };
          this.setStep(pid, t.id, s.id, a.status, a.note);
          return { observation: `Step ${a.stepIndex} is now ${a.status}.` };
        }
        case "propose_edit": {
          const r = resolveInRoot(p.root, a.path);
          if (isProtected(r.rel)) return { observation: `${r.rel} is protected; you can't change it.` };
          if (a.content.length > RUN_LIMITS.maxFileBytesForEdit) return { observation: "That file is too large to edit through Lumen." };
          const base = r.exists ? fs.readFileSync(r.abs) : null;
          if (base && base.subarray(0, 8000).includes(0)) return { observation: `${r.rel} is binary; you can't edit it.` };
          const baseText = base ? base.toString("utf8") : null;
          if (baseText === a.content) return { observation: "That content is identical to the current file; nothing to change." };
          const appr = this.db.addApproval({
            projectId: pid,
            taskId: t.id,
            runId,
            kind: "edit",
            payload: { path: r.rel, content: a.content, baseHash: base ? fingerprint(base) : null, baseText, reason: redactCredentials(a.reason) },
            createdAt: this.now(),
          });
          this.setStatus(pid, t.id, "waiting_approval", `Approve or reject the edit to ${r.rel}.`);
          return { observation: `Edit proposed for ${r.rel}; waiting for the user's approval.`, summary: `approval ${appr.id.slice(0, 8)}`, stop: true };
        }
        case "run_command": {
          const argv = validateArgv(a.argv);
          if (this.commandAllowed(p, argv, undefined, t.id)) {
            const v = await this.verify(pid, { argv, taskId: t.id, label: argv.join(" ") });
            if (signal.aborted) return { observation: "Cancelled.", stop: true };
            return { observation: commandObservation(v), summary: v.status };
          }
          const appr = this.db.addApproval({ projectId: pid, taskId: t.id, runId, kind: "command", payload: { argv, reason: redactCredentials(a.reason), cwd: "." }, createdAt: this.now() });
          this.setStatus(pid, t.id, "waiting_approval", `Approve or reject running: ${argv.join(" ")}`);
          return { observation: `Command ${JSON.stringify(argv)} needs the user's approval; waiting.`, summary: `approval ${appr.id.slice(0, 8)}`, stop: true };
        }
        case "ask_user":
          this.block(t, `The agent asks: ${a.question}`);
          return { observation: "Asked the user; the task is blocked until they answer (by editing the task) and resume.", stop: true };
        case "finish": {
          this.event(t, runId, "finish", a.summary.slice(0, 900), { findings: a.findings ?? [] });
          this.setStatus(pid, t.id, "verifying", null);
          const out = this.evaluateCompletion(pid, t.id);
          if (out.status === "verifying") {
            // Not completed: say why, and let the agent run the verification if one is configured.
            const why = out.reason ?? "Completion criteria not met.";
            const cmd = p.settings.verifyCommands[0];
            if (cmd && /verification/.test(why)) {
              const v = await this.verify(pid, { argv: cmd.argv, taskId: t.id, label: cmd.label });
              const after = this.evaluateCompletion(pid, t.id);
              return { observation: `Verification ran: ${commandObservation(v)}\nTask status: ${after.status}.`, stop: true };
            }
            this.setStatus(pid, t.id, "running", null);
            return { observation: `Not complete yet: ${why}` };
          }
          return { observation: `Task status: ${out.status}.`, stop: true };
        }
      }
    } catch (err) {
      if (err instanceof TransitionError || err instanceof BoundaryError || err instanceof Error) return { observation: `Error: ${(err as Error).message}` };
      throw err;
    }
  }

  private rememberFile(t: TaskRecord, rel: string, hash: string) {
    const cp = this.task(t.projectId, t.id).checkpoint;
    const files = { ...(cp?.files ?? {}), [rel]: hash };
    this.db.updateTask(t.projectId, t.id, { checkpoint: { ...(cp ?? emptyCheckpoint(this.now())), files, at: this.now() } }, this.now());
  }

  private checkpoint(projectId: string, taskId: string, runId: string, findings: string[] | null) {
    const t = this.task(projectId, taskId);
    const cp = t.checkpoint ?? emptyCheckpoint(this.now());
    const next = readySteps(this.steps(projectId, taskId))[0];
    this.db.updateTask(
      projectId,
      taskId,
      { checkpoint: { ...cp, runId, at: this.now(), findings: findings ? findings.map(redactCredentials).slice(0, 30) : cp.findings, nextAction: next ? `Step: ${next.title}` : t.reason } },
      this.now(),
    );
  }

  private block(t: TaskRecord, reason: string) {
    const cur = this.task(t.projectId, t.id);
    if (cur.status === "blocked") return;
    try {
      this.setStatus(t.projectId, t.id, "blocked", reason);
    } catch {
      this.db.updateTask(t.projectId, t.id, { reason }, this.now());
    }
  }

  private fail(t: TaskRecord, reason: string) {
    try {
      this.setStatus(t.projectId, t.id, "failed", reason);
    } catch {
      /* already terminal */
    }
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /**
   * After a restart: tasks left running/verifying have no live process. Mark them paused (with the
   * reason), mark unfinished verification runs "interrupted" (their outcome is unknown), and keep
   * pending approvals — they are re-validated when decided.
   */
  recoverAfterRestart(): { tasks: number; verifications: number } {
    const v = this.db.interruptRunningVerifications(this.now());
    let n = 0;
    for (const t of this.db.activeTasks()) {
      if (this.runs.has(t.id)) continue;
      // running → paused and verifying → (no direct edge) are both validated; verifying goes via running.
      const reason = "Lumen was closed while this task was running. Review the recovery summary, then resume.";
      const route: TaskStatus[] = t.status === "verifying" ? ["running", "paused"] : ["paused"];
      let from = t.status;
      for (const to of route) from = transition(from, to);
      this.db.updateTask(t.projectId, t.id, { status: from, reason }, this.now());
      this.event(t, null, "recovered", `Interrupted while ${t.status}; paused for review`);
      n++;
    }
    return { tasks: n, verifications: v };
  }

  /**
   * What happened, what's left, and what changed on disk since the last checkpoint. Built from
   * persisted records and the files as they are now — not by replaying the old conversation.
   */
  recoverySummary(projectId: string, taskId: string) {
    const t = this.task(projectId, taskId);
    const p = this.project(projectId);
    const status = rootStatus(p.root);
    const steps = this.steps(projectId, taskId);
    const done = steps.filter((s) => s.status === "done").map((s) => s.title);
    const open = steps.filter((s) => s.status !== "done" && s.status !== "skipped").map((s) => s.title);
    const changedFiles: string[] = [];
    const missingFiles: string[] = [];
    if (status === "available")
      for (const [rel, hash] of Object.entries(t.checkpoint?.files ?? {})) {
        try {
          const r = resolveInRoot(p.root, rel);
          if (!r.exists) missingFiles.push(rel);
          else if (fingerprint(fs.readFileSync(r.abs)) !== hash) changedFiles.push(rel);
        } catch {
          missingFiles.push(rel);
        }
      }
    const pending = this.db.listApprovals(projectId, { taskId, status: "pending" });
    const stalePending = pending.filter((a) => {
      if (a.kind !== "edit") return false;
      const pl = a.payload as { path: string; baseHash: string | null };
      try {
        const r = resolveInRoot(p.root, pl.path);
        return (r.exists ? fingerprint(fs.readFileSync(r.abs)) : null) !== pl.baseHash;
      } catch {
        return true;
      }
    });
    const latest = this.db.listVerifications(projectId, { taskId, limit: 1 })[0] ?? null;
    const verification = latest ? { label: latest.label, status: latest.status, current: status === "available" && this.isCurrent(latest) } : null;
    const lines = [
      `Status: ${t.status}${t.reason ? ` — ${t.reason.replace(/[.\s]+$/, "")}` : ""}.`,
      status !== "available" ? `The project folder is ${status}; nothing can run until it is available.` : "",
      done.length ? `Done: ${done.join("; ")}.` : "",
      open.length ? `Remaining: ${open.join("; ")}.` : steps.length ? "All plan steps are done." : "No plan yet.",
      t.checkpoint?.findings.length ? `Findings so far: ${t.checkpoint.findings.join("; ")}.` : "",
      changedFiles.length ? `Changed since the last checkpoint (re-read before relying on them): ${changedFiles.join(", ")}.` : "",
      missingFiles.length ? `No longer present: ${missingFiles.join(", ")}.` : "",
      pending.length ? `${pending.length} approval request(s) pending${stalePending.length ? `; ${stalePending.length} no longer match the file on disk and will not apply` : ""}.` : "",
      verification
        ? `Last verification: ${verification.label} ${verification.status}${verification.current ? "" : " (out of date — files changed since, or it never finished)"}.`
        : "No verification has run.",
      t.checkpoint?.nextAction ? `Next: ${t.checkpoint.nextAction.replace(/[.\s]+$/, "")}.` : "",
    ].filter(Boolean);
    return { text: lines.join("\n"), status, done, open, changedFiles, missingFiles, pendingApprovals: pending.length, stalePendingApprovals: stalePending.map((a) => a.id), verification };
  }

  // ───────────────────────────── dashboard ─────────────────────────────

  dashboard(projectId: string) {
    const p = this.project(projectId);
    const tasks = this.db.listTasks(projectId);
    const verifications = this.db.listVerifications(projectId, { limit: 10 }).map((v) => ({ ...v, output: v.output.slice(-4000), current: this.isCurrentSafe(v) }));
    return {
      project: this.view(p),
      tasks: tasks.map((t) => ({ ...t, running: this.runs.has(t.id), blocker: t.status === "verifying" ? this.completionBlockerFor(t) : null })),
      approvals: this.approvals(projectId, { status: "pending" }),
      changes: this.changes(projectId).slice(0, 20),
      verifications,
      activity: this.db.recentEvents(projectId, 25),
      index: this.indexes.get(projectId)?.state ?? null,
    };
  }

  private isCurrentSafe(v: VerificationRecord) {
    try {
      return this.isCurrent(v);
    } catch {
      return false;
    }
  }

  async shutdown() {
    for (const r of this.runs.values()) r.ctrl.abort("shutdown");
    for (const c of this.verifyRuns.values()) c.abort();
    await Promise.allSettled([...this.runs.values()].map((r) => r.promise));
  }

  /** For tests: whether a status is one with work in flight. */
  static isActive(s: TaskStatus) {
    return ACTIVE.has(s);
  }
}

function emptyCheckpoint(at: number): Checkpoint {
  return { files: {}, findings: [], openQuestions: [], nextAction: null, runId: null, at };
}

function modeOf(abs: string): number {
  try {
    return fs.statSync(abs).mode & 0o777;
  } catch {
    return 0o644;
  }
}

function numbered(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join("\n");
}

function commandObservation(v: VerificationRecord): string {
  return `Command ${JSON.stringify(v.argv)} ${v.status}${v.exitCode != null ? ` (exit ${v.exitCode})` : ""}. Output (last part):\n${v.output.slice(-6000)}`;
}

export { DEFAULT_PROJECT_SETTINGS };
