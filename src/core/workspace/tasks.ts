// Task state machine. Transitions are validated here; the store never writes a status that did
// not pass `transition()`.
//
//   backlog ⇄ ready → running ⇄ waiting_approval
//                      running → verifying → completed | failed
//                      running → paused → ready / running
//   any active → blocked | failed | cancelled ;  failed/cancelled/blocked → ready (retry)
//
// "completed" is only reachable from "verifying", and only when `canComplete` accepts the evidence:
// a model saying "done" is not evidence. Tasks that don't require verification still complete
// through "verifying" with the reason recorded.

export const TASK_STATUSES = ["backlog", "ready", "running", "waiting_approval", "paused", "verifying", "blocked", "failed", "cancelled", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  running: "Running",
  waiting_approval: "Waiting for approval",
  paused: "Paused",
  verifying: "Verifying",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
};

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready", "cancelled"],
  ready: ["backlog", "running", "cancelled", "blocked"],
  running: ["waiting_approval", "paused", "verifying", "blocked", "failed", "cancelled"],
  waiting_approval: ["running", "blocked", "failed", "cancelled", "paused"],
  paused: ["ready", "running", "cancelled"],
  verifying: ["completed", "failed", "running", "blocked", "cancelled"],
  blocked: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  cancelled: ["ready"],
  completed: ["ready"],
};

/** Statuses in which a process or model call may be in flight. */
export const ACTIVE: ReadonlySet<TaskStatus> = new Set(["running", "verifying"]);

export class TransitionError extends Error {}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function transition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) throw new TransitionError(`A ${STATUS_LABELS[from].toLowerCase()} task can't become ${STATUS_LABELS[to].toLowerCase()}.`);
  return to;
}

export interface CompletionEvidence {
  verificationRequired: boolean;
  /** Latest verification for this task: its status, and whether it is still current. */
  latest: { status: string; current: boolean } | null;
  /** Steps still open (not done/skipped). */
  openSteps: number;
  /** Pending approvals for this task. */
  pendingApprovals: number;
}

/** Whether evidence supports "completed". Returns the reason it doesn't, or null. */
export function completionBlocker(e: CompletionEvidence): string | null {
  if (e.pendingApprovals) return `${e.pendingApprovals} approval request${e.pendingApprovals === 1 ? " is" : "s are"} still pending.`;
  if (e.openSteps) return `${e.openSteps} plan step${e.openSteps === 1 ? " is" : "s are"} not done.`;
  if (!e.verificationRequired) return null;
  if (!e.latest) return "No verification has been run for this task.";
  if (!e.latest.current) return "The last verification ran before the latest changes; run it again.";
  if (e.latest.status !== "passed") return `The last verification ${e.latest.status.replace("_", " ")}.`;
  return null;
}

export const STEP_STATUSES = ["todo", "doing", "done", "skipped", "blocked"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepLike {
  id: string;
  status: StepStatus;
  dependsOn: string[];
}

/** Steps whose dependencies are all done/skipped and that are still todo. */
export function readySteps<T extends StepLike>(steps: T[]): T[] {
  const doneish = new Set(steps.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  return steps.filter((s) => s.status === "todo" && s.dependsOn.every((d) => doneish.has(d)));
}

/** Reject unknown dependencies and cycles. */
export function validateDependencies(steps: { id: string; dependsOn: string[] }[]): void {
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) for (const d of s.dependsOn) if (!ids.has(d)) throw new TransitionError(`Step depends on an unknown step.`);
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new TransitionError("Plan steps can't depend on each other in a cycle.");
    state.set(id, 1);
    for (const d of byId.get(id)!.dependsOn) visit(d);
    state.set(id, 2);
  };
  for (const s of steps) visit(s.id);
}

/** A new order is allowed only if every step still comes after the steps it depends on. */
export function validateOrder(order: string[], steps: { id: string; dependsOn: string[] }[]): void {
  if (order.length !== steps.length || new Set(order).size !== order.length || !order.every((id) => steps.some((s) => s.id === id)))
    throw new TransitionError("The new order must list every step once.");
  const pos = new Map(order.map((id, i) => [id, i]));
  for (const s of steps) for (const d of s.dependsOn) if (pos.get(d)! > pos.get(s.id)!) throw new TransitionError("A step can't move before a step it depends on.");
}
