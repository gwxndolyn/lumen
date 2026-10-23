// @vitest-environment jsdom
// Desktop UX: command palette (open/dismiss, fuzzy search, keyboard, focus, no double-fire,
// state-aware commands), copy actions, context-chip controls, window geometry, interrupted recordings.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LumenApi } from "../shared/api";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { applySettingsPatch } from "../shared/settingsSchema";
import type { ContextItemSummary, Settings } from "../shared/types";
import { fuzzyScore, onceGuard, rankCommands, type Command } from "../renderer/lib/commands";
import { MAIN_DEFAULT, MAIN_MIN, resolveMainBounds } from "../../electron/geometry";

type Calls = Record<string, unknown[][]>;
let calls: Calls;
function mockApi(over: Partial<LumenApi> = {}) {
  calls = {};
  const track =
    (name: string, ret: unknown = undefined) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(ret);
    };
  // The renderer captures `window.lumen` once at import, so update the same object in place.
  const w = window as unknown as { lumen?: Partial<LumenApi> };
  w.lumen ??= {};
  for (const k of Object.keys(w.lumen)) delete (w.lumen as Record<string, unknown>)[k];
  Object.assign(w.lumen, {
    platform: "darwin",
    createSession: track("createSession", { id: "s2" }) as never,
    switchSession: track("switchSession") as never,
    copyText: track("copyText") as never,
    overlay: track("overlay") as never,
    clearContext: track("clearContext", []) as never,
    liveScreen: track("liveScreen") as never,
    transcriptPause: track("transcriptPause") as never,
    transcriptResume: track("transcriptResume") as never,
    transcriptStop: track("transcriptStop") as never,
    updateSettings: track("updateSettings") as never,
    updateContext: track("updateContext", []) as never,
    removeContext: track("removeContext", []) as never,
    onApp: () => () => undefined,
    ...over,
  });
}

beforeEach(() => mockApi());
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const settings = (p: Record<string, unknown> = {}): Settings => applySettingsPatch(DEFAULT_SETTINGS, { onboardingComplete: true, ...p });

async function palette(opts: Partial<Parameters<typeof import("../renderer/components/CommandPalette").buildCommands>[0]> = {}) {
  const { CommandPalette, buildCommands } = await import("../renderer/components/CommandPalette");
  const go = vi.fn();
  const notify = vi.fn();
  const commands = buildCommands({ settings: settings(), sessions: [], activeSessionId: "s1", live: { status: "idle" }, liveScreen: null, latestAnswer: null, go, notify, ...opts });
  const onClose = vi.fn();
  const r = render(
    <div>
      <button>outside</button>
      <CommandPalette open onClose={onClose} commands={commands} />
    </div>,
  );
  return { ...r, commands, go, notify, onClose, input: r.getByRole("combobox") as HTMLInputElement };
}

describe("fuzzy matching", () => {
  it("matches subsequences, prefers word starts, rejects non-matches", () => {
    expect(fuzzyScore("ns", "New session")).not.toBeNull();
    expect(fuzzyScore("xyz", "New session")).toBeNull();
    expect(fuzzyScore("set", "Settings")!).toBeGreaterThan(fuzzyScore("set", "Reset context")!);
    const cmds: Command[] = ["Open settings", "New session", "Search conversation history"].map((t, i) => ({ id: String(i), title: t, section: "Navigate", run: () => undefined }));
    expect(rankCommands(cmds, "hist")[0]!.title).toBe("Search conversation history");
    expect(rankCommands(cmds, "")).toHaveLength(3);
  });

  it("keywords match too (synonyms)", () => {
    const c: Command[] = [{ id: "a", title: "Keyboard shortcuts", section: "Settings", keywords: "hotkeys", run: () => undefined }];
    expect(rankCommands(c, "hotkeys")).toHaveLength(1);
  });

  it("onceGuard blocks double-fire while running and within the window", async () => {
    let t = 0;
    const g = onceGuard(400, () => t);
    let n = 0;
    let release!: () => void;
    const p = g(() => new Promise<void>((r) => ((release = r), n++)));
    expect(await g(() => void n++)).toBe(false); // still running
    release();
    await p;
    expect(await g(() => void n++)).toBe(false); // inside the window
    t = 500;
    expect(await g(() => void n++)).toBe(true);
    expect(n).toBe(2);
  });
});

describe("command palette", () => {
  it("focuses the search box on open and shows commands", async () => {
    const { input, getAllByRole } = await palette();
    expect(document.activeElement).toBe(input);
    expect(getAllByRole("option").length).toBeGreaterThan(5);
  });

  it("Escape dismisses; clicking the backdrop dismisses", async () => {
    const { input, onClose, container } = await palette();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(container.querySelector(".palette-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("filters, navigates with arrows and runs with Enter — once, even on key repeat", async () => {
    const { input, getAllByRole, go } = await palette();
    fireEvent.change(input, { target: { value: "privacy" } });
    const opts = getAllByRole("option");
    expect(opts[0]!.textContent).toMatch(/Privacy & data/);
    expect(opts[0]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter", repeat: true });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("privacy");
  });

  it("ArrowDown moves the active option (announced via aria-activedescendant)", async () => {
    const { input } = await palette();
    const first = input.getAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).not.toBe(first);
  });

  it("shows an empty state", async () => {
    const { input, getByText } = await palette();
    fireEvent.change(input, { target: { value: "zzzzqqq" } });
    expect(getByText("No matching command.")).toBeTruthy();
  });

  it("only lists commands that apply to the current state", async () => {
    const idle = await palette();
    const ids = idle.commands.map((c) => c.id);
    expect(ids).not.toContain("answer.copy");
    expect(ids).not.toContain("rec.stop");
    expect(ids).not.toContain("live.pause");
    expect(ids).not.toContain("provider.anthropic"); // already the provider
    expect(ids).not.toContain("provider.ollama"); // no local model configured
    idle.unmount();
    const busy = await palette({
      settings: settings({ consent: { screen: true, microphone: true }, inference: { local: { model: "llama3.2" } } }),
      live: { status: "recording" },
      liveScreen: { active: true, paused: false, intervalSec: 10, lastCaptureAt: null, lastError: null, captures: 0, skipped: 0 },
      latestAnswer: "Answer text",
      sessions: [{ id: "s9", title: "Planning", type: "meeting" } as never],
    });
    const b = busy.commands.map((c) => c.id);
    expect(b).toEqual(expect.arrayContaining(["answer.copy", "rec.pause", "rec.stop", "live.pause", "live.stop", "provider.ollama", "session.open.s9"]));
    expect(b).not.toContain("rec.resume");
  });

  it("commands call the real API", async () => {
    const { commands, notify } = await palette({ latestAnswer: "The answer", sessions: [{ id: "s9", title: "Planning", type: "meeting" } as never] });
    const run = (id: string) => commands.find((c) => c.id === id)!.run();
    await run("answer.copy");
    expect(calls.copyText).toEqual([["The answer"]]);
    expect(notify).toHaveBeenCalled();
    await run("session.new");
    expect(calls.createSession).toHaveLength(1);
    await run("session.open.s9");
    expect(calls.switchSession).toEqual([["s9"]]);
    await run("overlay.compact");
    expect(calls.overlay).toEqual([["compact"]]);
    await run("context.clear");
    expect(calls.clearContext).toHaveLength(1);
  });

  it("a failing command shows the error and keeps the palette open", async () => {
    mockApi({ overlay: (() => Promise.reject(new Error("Panel unavailable"))) as never });
    const { input, getByRole, onClose } = await palette();
    fireEvent.change(input, { target: { value: "panel compact" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(getByRole("alert").textContent).toMatch(/Panel unavailable/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the previously focused element when closed", async () => {
    const { CommandPalette } = await import("../renderer/components/CommandPalette");
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    const r = render(<CommandPalette open onClose={() => undefined} commands={[]} />);
    await act(async () => await Promise.resolve()); // focus moves in a microtask
    expect(document.activeElement).not.toBe(btn);
    r.rerender(<CommandPalette open={false} onClose={() => undefined} commands={[]} />);
    expect(document.activeElement).toBe(btn);
  });
});

describe("context chips", () => {
  const item: ContextItemSummary = {
    id: "c1",
    source: "ocr",
    title: "Invoice",
    status: "active",
    enabled: true,
    pinned: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    ocr: "done",
    confidence: 0.9,
    sensitivity: "normal",
    sensitiveKinds: [],
    permission: "screen",
    suspicious: false,
    warning: null,
    preview: "Total due…",
  } as ContextItemSummary;

  it("toggle, pin and remove call the API; label names the source", async () => {
    const { ContextChips } = await import("../renderer/components/ui");
    const { getByLabelText, getByRole } = render(<ContextChips items={[item]} />);
    expect(getByRole("group").getAttribute("aria-label")).toBe("Screen text: Invoice");
    expect(getByRole("group").getAttribute("title")).toMatch(/Screen text · added/);
    fireEvent.click(getByLabelText("Disable Invoice"));
    fireEvent.click(getByLabelText("Pin Invoice"));
    fireEvent.click(getByLabelText("Remove Invoice"));
    expect(calls.updateContext).toEqual([
      ["c1", { enabled: false }],
      ["c1", { pinned: true }],
    ]);
    expect(calls.removeContext).toEqual([["c1"]]);
  });
});

describe("main window geometry", () => {
  const primary = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
  const second = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

  it("first run: centred default size", () => {
    const r = resolveMainBounds(null, [primary], primary);
    expect(r).toMatchObject({ width: MAIN_DEFAULT.width, height: MAIN_DEFAULT.height });
    expect(r.x).toBe(Math.round((1440 - MAIN_DEFAULT.width) / 2));
  });

  it("restores a saved rect on a connected display", () => {
    expect(resolveMainBounds({ x: 1600, y: 100, width: 1200, height: 800, displayId: 2 }, [primary, second], primary)).toEqual({ x: 1600, y: 100, width: 1200, height: 800 });
  });

  it("moves back on-screen when the display is gone, and never below the minimum size", () => {
    const r = resolveMainBounds({ x: 1600, y: 100, width: 300, height: 200, displayId: 2 }, [primary], primary);
    expect(r.x + r.width).toBeLessThanOrEqual(1440);
    expect(r.width).toBe(MAIN_MIN.width);
    expect(r.height).toBe(MAIN_MIN.height);
  });

  it("geometry is persisted in settings and survives upgrade", async () => {
    const { loadSettings } = await import("../shared/settingsSchema");
    expect(loadSettings({ version: 1 }).mainWindow).toEqual({ bounds: null, maximized: false });
    const s = applySettingsPatch(DEFAULT_SETTINGS, { mainWindow: { bounds: { x: 10, y: 20, width: 1000, height: 700, displayId: 1 }, maximized: true } });
    expect(s.mainWindow.maximized).toBe(true);
  });
});

describe("response streaming in the chat hook", () => {
  it("ignores events from an older request, and shows 'done' only after the provider finished", async () => {
    let onChat: ((e: unknown) => void) | null = null;
    const sent: { requestId: string }[] = [];
    mockApi({
      onChat: ((fn: (e: unknown) => void) => ((onChat = fn), () => undefined)) as never,
      onTranscript: (() => () => undefined) as never,
      chatSend: ((req: { requestId: string }) => (sent.push(req), Promise.resolve())) as never,
      chatCancel: (() => Promise.resolve(true)) as never,
      openConversation: (() => Promise.resolve(null)) as never,
    });
    const { renderHook } = await import("@testing-library/react");
    const { useChat } = await import("../renderer/lib/hooks");
    const { result } = renderHook(() => useChat(settings(), { restore: false }));
    await act(async () => void (await result.current.send("Question", { includeLiveTranscript: false })));
    const rid = sent[0]!.requestId;
    const emit = (e: unknown) => act(() => onChat!(e));
    await emit({
      type: "start",
      requestId: rid,
      conversationId: "c1",
      userMessageId: "u1",
      references: [],
      provider: { kind: "anthropic", model: "m", isMock: false },
      warnings: [],
      availability: null,
      intent: { category: "general" },
      selection: null,
    });
    await emit({ type: "delta", requestId: rid, text: "Hello " });
    await emit({ type: "delta", requestId: "stale-old-request", text: "WRONG" });
    let last = result.current.messages.at(-1)!;
    expect(last.content).toBe("Hello ");
    expect(last.status).toBe("streaming");
    expect(result.current.busy).toBe(true);
    await emit({ type: "delta", requestId: rid, text: "world" });
    await emit({
      type: "done",
      requestId: rid,
      messageId: "m1",
      usage: { estimatedCostUsd: 0 },
      ttftMs: 1,
      totalMs: 2,
      stopReason: "end_turn",
      servedByFallback: null,
      citedLabels: [],
      verification: { checksRun: 0, findings: [] },
    });
    last = result.current.messages.at(-1)!;
    expect(last).toMatchObject({ content: "Hello world", status: "done", id: "m1" });
    expect(result.current.busy).toBe(false);
    // A late event for the finished request changes nothing.
    await emit({ type: "delta", requestId: rid, text: "!!" });
    expect(result.current.messages.at(-1)!.content).toBe("Hello world");
  });
});
