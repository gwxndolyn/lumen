// @vitest-environment jsdom
// Projects screen against a stubbed bridge: empty, loading/failure, populated, opening a task,
// approving an edit, and a missing project folder. The stub returns shapes produced by the real
// WorkspaceService types; the backend itself is covered end to end in workspace.test.ts.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Set<(e: unknown) => void>();
const project = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "demo app",
  root: "/Users/x/code/demo app",
  createdAt: 1,
  lastOpenedAt: 2,
  settings: { excludes: [], verifyCommands: [{ label: "test", argv: ["npm", "test"] }], allowedCommands: [], editPolicy: "ask_each", commandTimeoutSec: 300, model: null },
  notes: "",
  status: "available",
  taskCounts: { waiting_approval: 1 },
  ...over,
});
const task = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project().id,
  title: "Fix failing tests",
  description: "d",
  status: "waiting_approval",
  priority: 2,
  tags: [],
  reason: "Approve or reject the edit to src/math.js.",
  createdAt: 1,
  updatedAt: 2,
  checkpoint: null,
  verificationRequired: true,
};
const approval = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: project().id,
  taskId: task.id,
  runId: "r",
  kind: "edit",
  status: "pending",
  createdAt: 1,
  decidedAt: null,
  payload: { path: "src/math.js", reason: "add must add" },
  diff: {
    added: 1,
    removed: 1,
    tooLarge: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: "del", text: "a - b", oldNo: 1, newNo: null },
          { kind: "add", text: "a + b", oldNo: null, newNo: 1 },
        ],
      },
    ],
  },
};
const dashboard = {
  project: project(),
  tasks: [{ ...task, running: false, blocker: null }],
  approvals: [approval],
  changes: [],
  verifications: [
    {
      id: "v",
      projectId: project().id,
      taskId: task.id,
      label: "test",
      argv: ["npm", "test"],
      cwd: "/x",
      startedAt: 1,
      finishedAt: 2,
      status: "passed",
      exitCode: 0,
      output: "ok",
      fingerprint: "f",
      current: false,
    },
  ],
  activity: [],
  index: null,
};
const detail = {
  task,
  steps: [],
  events: [{ id: 1, taskId: task.id, projectId: project().id, runId: "r", at: 1, kind: "verification", summary: "test: failed (exit 1)", data: null }],
  approvals: [approval],
  changes: [],
  verifications: [],
  recovery: { text: "Status: waiting_approval." },
  running: false,
  blocker: "1 approval request is still pending.",
};

let api: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  api = {
    wsProjects: vi.fn(async () => [project()]),
    wsDashboard: vi.fn(async () => dashboard),
    wsOpenProject: vi.fn(async () => project()),
    wsTaskDetail: vi.fn(async () => detail),
    wsDecide: vi.fn(async () => undefined),
    wsAddProject: vi.fn(async () => null),
    wsGit: vi.fn(async () => ({ available: false, reason: "This folder is not a Git repository.", files: [], recent: [] })),
    wsIndex: vi.fn(async () => ({ status: "ready", files: 3, skipped: { protected: 1, ignored: 0, large: 0, binary: 0, unreadable: 0 }, note: null })),
    wsRelocateProject: vi.fn(async () => null),
  };
  (window as unknown as { lumen: unknown }).lumen = {
    ...api,
    platform: "darwin",
    onApp: (fn: (e: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.resetModules();
});
const mount = async () => {
  const { WorkspaceScreen } = await import("../renderer/screens/Workspace");
  render(<WorkspaceScreen />);
  await act(async () => {});
};

describe("Projects screen", () => {
  it("empty state offers to add a folder (and the button calls the real picker)", async () => {
    api.wsProjects!.mockResolvedValue([]);
    await mount();
    expect(screen.getByText("No projects yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add project folder…" })[0]!);
    expect(api.wsAddProject).toHaveBeenCalled();
  });

  it("shows a load failure with the reason", async () => {
    api.wsProjects!.mockRejectedValue(new Error("database is locked"));
    await mount();
    expect(screen.getByRole("alert").textContent).toMatch(/database is locked/);
  });

  it("populated: lists the project, surfaces what needs approval, and marks a stale pass", async () => {
    await mount();
    expect(screen.getByRole("navigation", { name: "Projects" }).textContent).toMatch(/demo app.*1 need approval/s);
    expect(screen.getByText("Needs you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Verification" }));
    await act(async () => {});
    expect(screen.getByText("out of date")).toBeTruthy();
  });

  it("opening a task shows the diff to approve, and approving calls the backend", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(screen.getByRole("region", { name: "Approval request" }).textContent).toMatch(/Approve edit to src\/math\.js/);
    expect(screen.getByRole("table", { name: /1 lines added, 1 removed/ })).toBeTruthy();
    expect(screen.getByText(/Completion: 1 approval request is still pending/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and write file" }));
    await act(async () => {});
    expect(api.wsDecide).toHaveBeenCalledWith(project().id, approval.id, "approved");
  });

  it("a missing project folder explains the problem and offers to locate it", async () => {
    api.wsProjects!.mockResolvedValue([project({ status: "missing", taskCounts: {} })]);
    await mount();
    expect(screen.getAllByText(/Folder missing/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Locate folder…" }));
    expect(api.wsRelocateProject).toHaveBeenCalledWith(project().id);
    expect(api.wsDashboard).not.toHaveBeenCalled();
  });

  it("refreshes when the backend reports a task change", async () => {
    await mount();
    const n = api.wsDashboard!.mock.calls.length;
    await act(async () => {
      for (const l of listeners) l({ type: "workspace", event: { type: "task-changed", projectId: project().id, taskId: task.id } });
    });
    expect(api.wsDashboard!.mock.calls.length).toBeGreaterThan(n);
    // …and the project list (its "needs approval" badge) is reloaded as well.
    expect(api.wsProjects!.mock.calls.length).toBeGreaterThan(1);
  });
});
