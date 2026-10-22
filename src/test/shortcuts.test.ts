import { describe, expect, it, vi } from "vitest";
import { canonical, reservedReason, SHORTCUT_ORDER, ShortcutManager, suggestAlternatives, validateAccelerator, type ShortcutAction, type ShortcutRegistrar } from "../core/shortcuts";
import { DEFAULT_SHORTCUTS } from "../shared/defaults";
import { loadSettings } from "../shared/settingsSchema";
import { toAccelerator } from "../renderer/lib/accelerator";

/** Fake native registrar mimicking Electron globalShortcut: one owner per accelerator. */
class FakeRegistrar implements ShortcutRegistrar {
  owners = new Map<string, () => void>();
  calls: string[] = [];
  constructor(public taken = new Set<string>()) {}
  register(acc: string, fn: () => void) {
    this.calls.push(`+${acc}`);
    if (this.taken.has(acc) || this.owners.has(acc)) return false;
    this.owners.set(acc, fn);
    return true;
  }
  unregister(acc: string) {
    this.calls.push(`-${acc}`);
    this.owners.delete(acc);
  }
  press(acc: string) {
    this.owners.get(acc)?.();
  }
}

function make(platform = "darwin", taken?: Set<string>, bindings = { ...DEFAULT_SHORTCUTS }) {
  const reg = new FakeRegistrar(taken);
  const fired: ShortcutAction[] = [];
  const handlers = Object.fromEntries(SHORTCUT_ORDER.map((a) => [a, () => fired.push(a)])) as Record<ShortcutAction, () => void>;
  const onChange = vi.fn();
  const m = new ShortcutManager(reg, platform, bindings, handlers, onChange);
  return { reg, m, fired, onChange };
}

describe("Cluely-style defaults", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere via CommandOrControl", () => {
    expect(DEFAULT_SHORTCUTS).toMatchObject({
      requestAssist: "CommandOrControl+Enter",
      toggleOverlay: "CommandOrControl+\\",
      scrollUp: "CommandOrControl+Up",
      scrollDown: "CommandOrControl+Down",
      moveLeft: "CommandOrControl+Left",
      moveRight: "CommandOrControl+Right",
      discreetInput: "CommandOrControl+Shift+Enter",
    });
    expect(canonical("CommandOrControl+Enter", "darwin")).toBe("cmd+enter");
    expect(canonical("CommandOrControl+Enter", "win32")).toBe("ctrl+enter");
    expect(canonical("CommandOrControl+Enter", "linux")).toBe("ctrl+enter");
    for (const acc of Object.values(DEFAULT_SHORTCUTS)) expect(validateAccelerator(acc), acc).toBeNull();
  });

  it("migrates the old ⌘⇧Space toggle default but keeps user-customised shortcuts", () => {
    expect(loadSettings({ shortcuts: { toggleOverlay: "CommandOrControl+Shift+Space" } }).shortcuts.toggleOverlay).toBe("CommandOrControl+\\");
    expect(loadSettings({ shortcuts: { toggleOverlay: "Alt+K" } }).shortcuts.toggleOverlay).toBe("Alt+K");
    expect(loadSettings({}).shortcuts.requestAssist).toBe("CommandOrControl+Enter");
  });
});

describe("registration", () => {
  it("registers 'always' shortcuts at start; arrow shortcuts only while the panel is visible", () => {
    const { reg, m } = make();
    m.apply();
    expect([...reg.owners.keys()].sort()).toEqual(
      ["CommandOrControl+Enter", "CommandOrControl+\\", "CommandOrControl+Shift+Enter", "CommandOrControl+Shift+S", "CommandOrControl+Shift+A", "CommandOrControl+Shift+L"].sort(),
    );
    expect(m.status().scrollUp.status).toBe("inactive");
    m.setPanelVisible(true);
    expect(reg.owners.has("CommandOrControl+Up")).toBe(true);
    expect(reg.owners.has("CommandOrControl+Left")).toBe(true);
    m.setPanelVisible(false);
    // Hidden again: ⌘/Ctrl+arrows are returned to other apps (text editing keeps working).
    expect(["CommandOrControl+Up", "CommandOrControl+Down", "CommandOrControl+Left", "CommandOrControl+Right"].some((a) => reg.owners.has(a))).toBe(false);
  });

  it("dispatches each accelerator to its action", () => {
    const { reg, m, fired } = make();
    m.setPanelVisible(true);
    for (const a of ["CommandOrControl+Enter", "CommandOrControl+\\", "CommandOrControl+Up", "CommandOrControl+Down", "CommandOrControl+Left", "CommandOrControl+Right", "CommandOrControl+Shift+Enter"]) reg.press(a);
    expect(fired).toEqual(["requestAssist", "toggleOverlay", "scrollUp", "scrollDown", "moveLeft", "moveRight", "discreetInput"]);
  });

  it("is idempotent — repeated apply() never double-registers", () => {
    const { reg, m } = make();
    m.apply();
    const n = reg.calls.length;
    m.apply();
    m.apply();
    m.setPanelVisible(false);
    expect(reg.calls.length).toBe(n);
  });

  it("reports OS/app conflicts with alternatives, and keeps the rest working", () => {
    const { m } = make("win32", new Set(["CommandOrControl+\\"]));
    m.apply();
    const st = m.status();
    expect(st.toggleOverlay.status).toBe("conflict");
    if (st.toggleOverlay.status !== "conflict") throw new Error();
    expect(st.toggleOverlay.alternatives.length).toBeGreaterThan(0);
    expect(st.toggleOverlay.alternatives).not.toContain("CommandOrControl+\\");
    expect(st.requestAssist.status).toBe("active");
  });

  it("detects duplicate bindings across actions without registering the second", () => {
    const { reg, m } = make("darwin", undefined, { ...DEFAULT_SHORTCUTS, openMainWindow: "CommandOrControl+Enter" });
    m.apply();
    expect(m.status().openMainWindow).toMatchObject({ status: "duplicate", with: "requestAssist" });
    expect([...reg.owners.keys()].filter((k) => k === "CommandOrControl+Enter")).toHaveLength(1);
    // Different spelling, same keys on macOS → still a duplicate.
    expect(canonical("Command+Enter", "darwin")).toBe(canonical("CommandOrControl+Enter", "darwin"));
  });

  it("rejects invalid and system-reserved shortcuts, and bare keys that would intercept typing", () => {
    expect(validateAccelerator("A")).toMatch(/ordinary typing/);
    expect(validateAccelerator("Shift+A")).toMatch(/ordinary typing/);
    expect(validateAccelerator("F9")).toBeNull();
    expect(validateAccelerator("CommandOrControl+Foo")).toMatch(/not a supported key/);
    expect(reservedReason("CommandOrControl+Q", "darwin")).toMatch(/Quit/);
    expect(reservedReason("Alt+F4", "win32")).toMatch(/Close/);
    const { m } = make("darwin", undefined, { ...DEFAULT_SHORTCUTS, askAboutScreen: "CommandOrControl+C" });
    m.apply();
    expect(m.status().askAboutScreen.status).toBe("conflict");
  });

  it("rebinding releases the old accelerator and registers the new one", () => {
    const { reg, m, fired } = make();
    m.apply();
    m.setBindings({ ...DEFAULT_SHORTCUTS, toggleOverlay: "Alt+Space" });
    expect(reg.owners.has("CommandOrControl+\\")).toBe(false);
    reg.press("Alt+Space");
    expect(fired).toEqual(["toggleOverlay"]);
  });

  it("disabling a shortcut (empty binding) unregisters it", () => {
    const { reg, m } = make();
    m.apply();
    m.setBindings({ ...DEFAULT_SHORTCUTS, discreetInput: "" });
    expect(reg.owners.has("CommandOrControl+Shift+Enter")).toBe(false);
    expect(m.status().discreetInput.status).toBe("disabled");
  });

  it("releaseAll() cleans up every registration (shutdown)", () => {
    const { reg, m } = make();
    m.setPanelVisible(true);
    m.releaseAll();
    expect(reg.owners.size).toBe(0);
    expect(m.owned()).toEqual([]);
  });

  it("a throwing native registrar is reported as a conflict, not a crash", () => {
    const reg: ShortcutRegistrar = { register: () => { throw new Error("native"); }, unregister: () => undefined };
    const handlers = Object.fromEntries(SHORTCUT_ORDER.map((a) => [a, () => undefined])) as Record<ShortcutAction, () => void>;
    const m = new ShortcutManager(reg, "darwin", DEFAULT_SHORTCUTS, handlers);
    expect(() => m.apply()).not.toThrow();
    expect(m.status().requestAssist.status).toBe("conflict");
  });

  it("suggests alternatives that are not reserved or already taken", () => {
    const alts = suggestAlternatives("CommandOrControl+Enter", "darwin", new Set([canonical("CommandOrControl+Shift+Enter", "darwin")]));
    expect(alts).not.toContain("CommandOrControl+Shift+Enter");
    expect(alts.length).toBeGreaterThan(0);
  });
});

describe("shortcut recorder (settings)", () => {
  const ev = (o: Partial<Parameters<typeof toAccelerator>[0]>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  it("records ⌘ on macOS and Ctrl on Windows into the portable CommandOrControl form", () => {
    expect(toAccelerator(ev({ code: "Backslash", key: "\\", metaKey: true }), "darwin")).toBe("CommandOrControl+\\");
    expect(toAccelerator(ev({ code: "Backslash", key: "\\", ctrlKey: true }), "win32")).toBe("CommandOrControl+\\");
    expect(toAccelerator(ev({ code: "Enter", key: "Enter", metaKey: true, shiftKey: true }), "darwin")).toBe("CommandOrControl+Shift+Enter");
    expect(toAccelerator(ev({ code: "ArrowLeft", key: "ArrowLeft", ctrlKey: true }), "win32")).toBe("CommandOrControl+Left");
    expect(toAccelerator(ev({ code: "KeyA", key: "A", shiftKey: true }), "win32")).toBeNull();
  });
});
