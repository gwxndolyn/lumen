// Global shortcut management, independent of Electron so it can be unit-tested.
// The Electron adapter (electron/platform/shortcuts.ts) supplies the native registrar.

export type ShortcutAction =
  | "requestAssist"
  | "toggleOverlay"
  | "scrollUp"
  | "scrollDown"
  | "moveLeft"
  | "moveRight"
  | "discreetInput"
  | "askAboutScreen"
  | "askAboutSelection"
  | "openMainWindow"
  | "cancelResponse"
  | "toggleAudio";

export type ShortcutBindings = Record<ShortcutAction, string>;

/**
 * "always": registered whenever Lumen runs.
 * "visible": registered only while the assistant panel is visible. Arrow-key shortcuts are scoped
 * this way so that, while the panel is hidden, ⌘/Ctrl+arrows keep working normally in other apps.
 */
export const SHORTCUT_SCOPE: Record<ShortcutAction, "always" | "visible"> = {
  requestAssist: "always",
  toggleOverlay: "always",
  scrollUp: "visible",
  scrollDown: "visible",
  moveLeft: "visible",
  moveRight: "visible",
  discreetInput: "always",
  askAboutScreen: "always",
  askAboutSelection: "always",
  openMainWindow: "always",
  cancelResponse: "always",
  toggleAudio: "always",
};

export const SHORTCUT_ORDER: ShortcutAction[] = [
  "requestAssist",
  "toggleOverlay",
  "scrollUp",
  "scrollDown",
  "moveLeft",
  "moveRight",
  "discreetInput",
  "askAboutScreen",
  "askAboutSelection",
  "openMainWindow",
  "cancelResponse",
  "toggleAudio",
];

export type ShortcutState =
  | { status: "active"; accelerator: string }
  | { status: "inactive"; accelerator: string; reason: string }
  | { status: "conflict"; accelerator: string; reason: string; alternatives: string[] }
  | { status: "duplicate"; accelerator: string; reason: string; with: ShortcutAction }
  | { status: "invalid"; accelerator: string; reason: string }
  | { status: "disabled"; accelerator: string };

export interface ShortcutRegistrar {
  /** Returns false when the OS or another application already owns the accelerator. */
  register(accelerator: string, handler: () => void): boolean;
  unregister(accelerator: string): void;
}

const MODIFIERS = ["CommandOrControl", "CmdOrCtrl", "Command", "Cmd", "Control", "Ctrl", "Alt", "Option", "AltGr", "Shift", "Super", "Meta"];
const KEY_RE = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Escape|Esc|Plus|[\\[\];',./`=-])$/;

/** Canonical form for duplicate detection: modifiers resolved for the platform and sorted. */
export function canonical(accelerator: string, platform: string): string {
  const parts = accelerator.split("+").filter(Boolean);
  // "+" itself must be written "Plus"; a trailing empty part means the key was "+".
  const key = parts.at(-1) ?? "";
  const mods = new Set<string>();
  for (const p of parts.slice(0, -1)) {
    const m = p.toLowerCase();
    if (m === "commandorcontrol" || m === "cmdorctrl") mods.add(platform === "darwin" ? "cmd" : "ctrl");
    else if (m === "command" || m === "cmd" || m === "super" || m === "meta") mods.add(platform === "darwin" ? "cmd" : "super");
    else if (m === "control" || m === "ctrl") mods.add("ctrl");
    else if (m === "alt" || m === "option") mods.add("alt");
    else mods.add(m);
  }
  const k = key.toLowerCase() === "return" ? "enter" : key.toLowerCase() === "esc" ? "escape" : key.toLowerCase();
  return [...[...mods].sort(), k].join("+");
}

export function validateAccelerator(accelerator: string): string | null {
  const parts = accelerator.split("+");
  if (parts.some((p) => !p)) return "Use “Plus” for the + key.";
  const key = parts.at(-1)!;
  const mods = parts.slice(0, -1);
  if (!KEY_RE.test(key)) return `“${key}” is not a supported key.`;
  for (const m of mods) if (!MODIFIERS.includes(m)) return `“${m}” is not a modifier.`;
  if (new Set(mods).size !== mods.length) return "A modifier is repeated.";
  // A bare key (or Shift+key) would capture ordinary typing in every app.
  const meaningful = mods.filter((m) => m !== "Shift");
  if (!meaningful.length && !/^F\d+$/.test(key)) return "Add ⌘/Ctrl, Alt or Control so ordinary typing is not intercepted.";
  return null;
}

/** Shortcuts the operating system reserves; registering them either fails or breaks the OS. */
export function reservedReason(accelerator: string, platform: string): string | null {
  const c = canonical(accelerator, platform);
  const mac: Record<string, string> = {
    "cmd+q": "Quit", "cmd+w": "Close window", "cmd+tab": "App switcher", "cmd+space": "Spotlight",
    "cmd+h": "Hide app", "cmd+m": "Minimise", "cmd+c": "Copy", "cmd+v": "Paste", "cmd+x": "Cut",
    "cmd+z": "Undo", "cmd+a": "Select all", "cmd+s": "Save", "cmd+`": "Cycle windows",
    "cmd+shift+3": "Screenshot", "cmd+shift+4": "Screenshot", "cmd+shift+5": "Screenshot",
  };
  const win: Record<string, string> = {
    "alt+f4": "Close window", "alt+tab": "App switcher", "ctrl+c": "Copy", "ctrl+v": "Paste", "ctrl+x": "Cut",
    "ctrl+z": "Undo", "ctrl+a": "Select all", "ctrl+s": "Save", "ctrl+alt+delete": "Security screen",
    "ctrl+escape": "Start menu", "ctrl+shift+escape": "Task Manager",
  };
  const table = platform === "darwin" ? mac : win;
  return table[c] ? `${table[c]} is a system shortcut.` : null;
}

/** Suggest a few nearby combinations to try when one is taken. */
export function suggestAlternatives(accelerator: string, platform: string, taken: Set<string>): string[] {
  const parts = accelerator.split("+");
  const key = parts.at(-1)!;
  const base = parts.slice(0, -1);
  const variants = [
    [...new Set([...base, "Alt"])],
    [...new Set([...base, "Shift"])],
    [...new Set([...base, "Alt", "Shift"])],
    base.includes("CommandOrControl") && platform === "darwin" ? [...base.filter((m) => m !== "CommandOrControl"), "Control", "Alt"] : null,
  ].filter((v): v is string[] => !!v);
  const out: string[] = [];
  for (const v of variants) {
    const order = ["CommandOrControl", "Control", "Alt", "Shift"];
    const acc = [...v.sort((a, b) => order.indexOf(a) - order.indexOf(b)), key].join("+");
    const c = canonical(acc, platform);
    if (acc !== accelerator && !taken.has(c) && !reservedReason(acc, platform) && !out.includes(acc)) out.push(acc);
  }
  return out.slice(0, 3);
}

/**
 * Keeps native registrations in sync with the user's bindings and the panel's visibility.
 * `apply()` is idempotent: it only registers what is missing and only unregisters what it owns,
 * so repeated calls never create duplicate registrations.
 */
export class ShortcutManager {
  private registered = new Map<string, ShortcutAction>(); // accelerator → action (only ones we own)
  private states = new Map<ShortcutAction, ShortcutState>();
  private visible = false;

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly platform: string,
    private bindings: ShortcutBindings,
    private readonly handlers: Record<ShortcutAction, () => void>,
    private readonly onChange: (states: Record<ShortcutAction, ShortcutState>) => void = () => undefined,
  ) {}

  setBindings(b: ShortcutBindings) {
    this.bindings = b;
    this.apply(true);
  }

  setPanelVisible(v: boolean) {
    if (this.visible === v) return;
    this.visible = v;
    this.apply();
  }

  get panelVisible() {
    return this.visible;
  }

  /** Dispatch an action directly (used by tests and the smoke test to exercise the wiring). */
  trigger(action: ShortcutAction) {
    this.handlers[action]();
  }

  status(): Record<ShortcutAction, ShortcutState> {
    return Object.fromEntries(SHORTCUT_ORDER.map((a) => [a, this.states.get(a) ?? { status: "disabled", accelerator: this.bindings[a] }])) as Record<ShortcutAction, ShortcutState>;
  }

  /**
   * Reconcile registrations. With `rebind`, every owned registration is released first so a changed
   * binding for the same action is picked up.
   */
  apply(rebind = false) {
    if (rebind) this.releaseAll();
    const want = new Map<string, ShortcutAction>();
    const seen = new Map<string, ShortcutAction>();
    const taken = new Set(SHORTCUT_ORDER.map((a) => canonical(this.bindings[a] ?? "", this.platform)));
    this.states.clear();

    for (const action of SHORTCUT_ORDER) {
      const acc = (this.bindings[action] ?? "").trim();
      if (!acc) {
        this.states.set(action, { status: "disabled", accelerator: "" });
        continue;
      }
      const invalid = validateAccelerator(acc);
      if (invalid) {
        this.states.set(action, { status: "invalid", accelerator: acc, reason: invalid });
        continue;
      }
      const reserved = reservedReason(acc, this.platform);
      if (reserved) {
        this.states.set(action, { status: "conflict", accelerator: acc, reason: reserved, alternatives: suggestAlternatives(acc, this.platform, taken) });
        continue;
      }
      const c = canonical(acc, this.platform);
      const dup = seen.get(c);
      if (dup) {
        this.states.set(action, { status: "duplicate", accelerator: acc, reason: `Also assigned to “${dup}”.`, with: dup });
        continue;
      }
      seen.set(c, action);
      if (SHORTCUT_SCOPE[action] === "visible" && !this.visible) {
        this.states.set(action, { status: "inactive", accelerator: acc, reason: "Active while the assistant panel is visible." });
        continue;
      }
      want.set(acc, action);
    }

    // Release registrations we no longer want.
    for (const [acc, action] of [...this.registered]) {
      if (want.get(acc) !== action) {
        this.registrar.unregister(acc);
        this.registered.delete(acc);
      }
    }
    // Register what is missing.
    for (const [acc, action] of want) {
      if (this.registered.get(acc) === action) {
        this.states.set(action, { status: "active", accelerator: acc });
        continue;
      }
      let ok = false;
      try {
        ok = this.registrar.register(acc, () => this.handlers[action]());
      } catch {
        ok = false;
      }
      if (ok) {
        this.registered.set(acc, action);
        this.states.set(action, { status: "active", accelerator: acc });
      } else {
        this.states.set(action, {
          status: "conflict",
          accelerator: acc,
          reason: "Another application or the operating system is already using this shortcut.",
          alternatives: suggestAlternatives(acc, this.platform, taken),
        });
      }
    }
    this.onChange(this.status());
  }

  releaseAll() {
    for (const acc of this.registered.keys()) this.registrar.unregister(acc);
    this.registered.clear();
  }

  /** Accelerators currently registered by Lumen (for diagnostics and tests). */
  owned(): string[] {
    return [...this.registered.keys()];
  }
}
