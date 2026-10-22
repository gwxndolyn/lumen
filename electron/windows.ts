import { app, BrowserWindow, screen, shell, type Rectangle } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Settings, WindowRole } from "../src/shared/types";
import { defaultOverlayRect, moveToDisplay, presetRect, resizeAnchored, resolveBounds } from "./geometry";

/** A dev-server URL is honoured only in unpackaged development builds. */
const DEV_URL = !app.isPackaged ? process.env.LUMEN_DEV_URL : undefined;
const RENDERER_FILE = pathToFileURL(path.join(__dirname, "../../dist-renderer/index.html")).href;
export const COMPACT_HEIGHT = 176;
/** Discreet-input mode: a single slim input bar. */
export const DISCREET_HEIGHT = 76;
export const DISCREET_WIDTH = 520;
/** Distance moved per ⌘/Ctrl+Left/Right press. */
export const MOVE_STEP = 64;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 56;

export function rendererUrl(route: string): string {
  if (DEV_URL) return `${DEV_URL}#${route}`;
  return `${RENDERER_FILE}#${route}`;
}

/** Only our exact bundled renderer document (any #route) is trusted for privileged IPC. */
export function isTrustedUrl(url: string): boolean {
  if (DEV_URL) return url === DEV_URL || url.startsWith(`${DEV_URL}#`) || url.startsWith(`${DEV_URL}/`);
  const base = url.split("#")[0];
  return base === RENDERER_FILE;
}

function hardenWebContents(win: BrowserWindow) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
}

function webPreferences(role: WindowRole): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: role === "main",
    // The overlay hosts audio capture while hidden, so it must not be throttled.
    backgroundThrottling: role === "main",
    additionalArguments: [`--lumen-role=${role}`],
  };
}

/**
 * Owns the floating overlay and the main window. Uses only standard, documented window behaviour:
 * the overlay is a normal frameless window that appears in screen shares and the window list.
 */
export class WindowManager {
  overlay: BrowserWindow | null = null;
  main: BrowserWindow | null = null;
  mode: "compact" | "expanded" | "discreet" = "compact";
  /** Size to return to when leaving discreet mode. */
  private preDiscreet: { mode: "compact" | "expanded"; width: number } | null = null;
  onVisibilityChange: (visible: boolean) => void = () => undefined;
  private saveTimer: NodeJS.Timeout | null = null;
  onRendererGone: (role: "overlay" | "main", reason: string) => void = () => undefined;
  /** Ignore move/resize events we caused ourselves when deciding whether the user customized position. */
  private programmatic = false;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly saveBounds: (b: Settings["overlay"]["bounds"], patch?: Partial<Settings["overlay"]>) => void,
    private readonly onModeChange: (mode: "compact" | "expanded" | "discreet") => void = () => undefined,
  ) {
    const relayout = () => this.ensureOverlayVisible();
    screen.on("display-removed", relayout);
    screen.on("display-metrics-changed", relayout);
    screen.on("display-added", relayout);
  }

  private displays() {
    return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
  }

  private primary() {
    const p = screen.getPrimaryDisplay();
    return { id: p.id, workArea: p.workArea };
  }

  private setBounds(rect: Rectangle) {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    this.programmatic = true;
    w.setBounds(rect);
    setTimeout(() => (this.programmatic = false), 50);
  }

  private initialRect(s: Settings): Rectangle {
    const width = s.overlay.bounds?.width ?? 560;
    if (s.overlay.position !== "custom") return presetRect(this.primary().workArea, s.overlay.position, width, COMPACT_HEIGHT);
    return s.overlay.bounds
      ? resolveBounds({ ...s.overlay.bounds, height: COMPACT_HEIGHT }, this.displays(), this.primary())
      : defaultOverlayRect(this.primary().workArea, width, COMPACT_HEIGHT);
  }

  createOverlay(): BrowserWindow {
    const s = this.getSettings();
    const win = new BrowserWindow({
      ...this.initialRect(s),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      hasShadow: true,
      title: "Lumen",
      backgroundColor: "#00000000",
      webPreferences: webPreferences("overlay"),
    });
    hardenWebContents(win);
    this.applyOverlaySettings(win, s);
    win.on("moved", () => this.scheduleSave("move"));
    win.on("resized", () => this.scheduleSave("resize"));
    win.on("show", () => this.onVisibilityChange(true));
    win.on("hide", () => this.onVisibilityChange(false));
    win.on("closed", () => {
      this.overlay = null;
      this.onVisibilityChange(false);
    });
    win.webContents.on("render-process-gone", (_e, d) => {
      this.onRendererGone("overlay", d.reason);
      if (d.reason === "clean-exit") return;
      // Recreate the panel so the user is never left without a working assistant.
      const wasVisible = win.isVisible();
      win.destroy();
      this.overlay = null;
      const fresh = this.createOverlay();
      if (wasVisible) fresh.once("ready-to-show", () => fresh.show());
    });
    void win.loadURL(rendererUrl("/overlay"));
    this.overlay = win;
    return win;
  }

  applyOverlaySettings(win: BrowserWindow | null = this.overlay, s: Settings = this.getSettings()) {
    if (!win || win.isDestroyed()) return;
    win.setOpacity(s.overlay.opacity);
    // "floating" keeps the panel above normal windows without covering system UI.
    win.setAlwaysOnTop(s.overlay.alwaysOnTop, "floating");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(s.overlay.alwaysOnTop, { visibleOnFullScreen: true });
  }

  /** Apply a preset position (or reset) immediately on the overlay's current display. */
  applyPosition(s: Settings = this.getSettings()) {
    const w = this.overlay;
    if (!w || w.isDestroyed() || s.overlay.position === "custom") return;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    this.setBounds(presetRect(area, s.overlay.position, b.width, b.height));
  }

  private scheduleSave(kind: "move" | "resize") {
    if (this.programmatic) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const w = this.overlay;
      if (!w || w.isDestroyed()) return;
      const b = w.getBounds();
      const d = screen.getDisplayMatching(b);
      const patch: Partial<Settings["overlay"]> = {};
      // A user drag makes the position custom; a user resize in expanded mode remembers the height.
      if (kind === "move") patch.position = "custom";
      if (kind === "resize" && this.mode === "expanded") patch.expandedHeight = Math.max(240, Math.min(2000, b.height));
      this.saveBounds({ ...b, height: Math.max(MIN_HEIGHT, b.height), displayId: d.id }, patch);
    }, 400);
  }

  /** Re-clamp the overlay after a monitor is unplugged, added or rearranged. */
  ensureOverlayVisible() {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    const next = resolveBounds({ ...b, displayId: screen.getDisplayMatching(b).id }, this.displays(), this.primary());
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) {
      this.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
    }
  }

  /**
   * Show the panel. With `focus: false` the panel appears without taking keyboard focus from the
   * app the user is working in (used by the visibility toggle and capture shortcuts).
   */
  showOverlay(opts: { focus?: boolean } = {}) {
    const focus = opts.focus ?? true;
    const w = this.overlay ?? this.createOverlay();
    const s = this.getSettings();
    if (s.overlay.followCursorDisplay) {
      const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const b = w.getBounds();
      const current = screen.getDisplayMatching(b);
      if (current.id !== cursorDisplay.id) {
        this.setBounds(
          s.overlay.position === "custom"
            ? (moveToDisplay(b, current.workArea, cursorDisplay.workArea) as Rectangle)
            : presetRect(cursorDisplay.workArea, s.overlay.position, b.width, b.height),
        );
      }
    }
    this.ensureOverlayVisible();
    const reveal = () => {
      if (focus) {
        w.show();
        w.focus();
        w.webContents.send("lumen:app", { type: "focus-input" });
      } else w.showInactive();
      this.onVisibilityChange(true);
    };
    if (w.webContents.isLoading()) w.once("ready-to-show", reveal);
    else reveal();
  }

  get overlayVisible(): boolean {
    return !!this.overlay && !this.overlay.isDestroyed() && this.overlay.isVisible();
  }

  hideOverlay() {
    if (!this.overlay || this.overlay.isDestroyed()) return;
    this.overlay.hide();
    // "hide" is not emitted when the window was already hidden; report state explicitly too.
    this.onVisibilityChange(false);
  }

  /**
   * Visibility toggle. Hiding never cancels a streaming answer (the renderer keeps running);
   * showing restores the previous position, size and mode without stealing focus.
   */
  toggleOverlay(opts: { focus?: boolean } = {}) {
    if (this.overlayVisible) this.hideOverlay();
    else this.showOverlay({ focus: opts.focus ?? false });
  }

  /** Move the panel horizontally within its display (⌘/Ctrl+Left/Right). Returns the new bounds. */
  nudge(direction: "left" | "right", step = MOVE_STEP) {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return null;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x + (direction === "left" ? -step : step), area.x), area.x + area.width - b.width);
    if (x === b.x) return b;
    w.setBounds({ ...b, x }); // user-initiated: saved as a custom position via the "moved" event
    return w.getBounds();
  }

  /** Enter or leave the slim discreet-input bar, restoring the previous layout on exit. */
  setDiscreet(on: boolean) {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    if (on && this.mode !== "discreet") {
      this.preDiscreet = { mode: this.mode, width: w.getBounds().width };
      this.mode = "discreet";
      const b = w.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      this.setBounds(resizeAnchored(b, area, Math.min(DISCREET_WIDTH, b.width), DISCREET_HEIGHT));
      this.onModeChange("discreet");
    } else if (!on && this.mode === "discreet") {
      const prev = this.preDiscreet ?? { mode: "compact" as const, width: 560 };
      this.preDiscreet = null;
      const b = w.getBounds();
      this.setBounds({ ...b, width: prev.width });
      this.setMode(prev.mode);
    }
  }

  setMode(mode: "compact" | "expanded") {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    if (this.mode === "discreet") this.preDiscreet = null;
    this.mode = mode;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const height = mode === "expanded" ? Math.min(this.getSettings().overlay.expandedHeight, area.height - 48) : COMPACT_HEIGHT;
    this.setBounds(resizeAnchored(b, area, Math.max(MIN_WIDTH, b.width), height));
    this.onModeChange(mode);
  }

  setOverlaySize(width: number, height: number) {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    this.setBounds(resizeAnchored(b, area, Math.min(Math.max(MIN_WIDTH, width), area.width), Math.min(Math.max(MIN_HEIGHT, height), area.height)));
  }

  resetPosition() {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.setBounds(presetRect(area, "top-center", 560, this.mode === "expanded" ? this.getSettings().overlay.expandedHeight : COMPACT_HEIGHT));
  }

  openMain(route = "/main/assistant") {
    if (this.main && !this.main.isDestroyed()) {
      this.main.webContents.send("lumen:app", { type: "navigate", to: route });
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return this.main;
    }
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 860,
      minHeight: 560,
      show: false,
      title: "Lumen",
      backgroundColor: "#0b0d12",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: webPreferences("main"),
    });
    hardenWebContents(win);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      this.main = null;
    });
    win.webContents.on("render-process-gone", (_e, d) => {
      this.onRendererGone("main", d.reason);
      if (d.reason !== "clean-exit" && !win.isDestroyed()) win.reload();
    });
    void win.loadURL(rendererUrl(route));
    this.main = win;
    return win;
  }

  broadcast(channel: string, payload: unknown) {
    for (const w of [this.overlay, this.main]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  all(): BrowserWindow[] {
    return [this.overlay, this.main].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
  }
}
