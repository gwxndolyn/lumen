import { BrowserWindow, screen, shell, type Rectangle } from "electron";
import path from "node:path";
import type { Settings, WindowRole } from "../src/shared/types";
import { defaultOverlayRect, moveToDisplay, presetRect, resizeAnchored, resolveBounds } from "./geometry";

const DEV_URL = process.env.LUMEN_DEV_URL;
export const COMPACT_HEIGHT = 176;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 140;

export function rendererUrl(route: string): string {
  if (DEV_URL) return `${DEV_URL}#${route}`;
  return `file://${path.join(__dirname, "../../dist-renderer/index.html")}#${route}`;
}

export function isTrustedUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith("file://") && url.includes("/dist-renderer/index.html");
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
  mode: "compact" | "expanded" = "compact";
  private saveTimer: NodeJS.Timeout | null = null;
  /** Ignore move/resize events we caused ourselves when deciding whether the user customized position. */
  private programmatic = false;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly saveBounds: (b: Settings["overlay"]["bounds"], patch?: Partial<Settings["overlay"]>) => void,
    private readonly onModeChange: (mode: "compact" | "expanded") => void = () => undefined,
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
    win.on("closed", () => {
      this.overlay = null;
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

  showOverlay() {
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
    if (w.webContents.isLoading()) w.once("ready-to-show", () => w.show());
    else w.show();
    w.focus();
    w.webContents.send("lumen:app", { type: "focus-input" });
  }

  hideOverlay() {
    this.overlay?.hide();
  }

  toggleOverlay() {
    if (this.overlay?.isVisible() && this.overlay.isFocused()) this.hideOverlay();
    else this.showOverlay();
  }

  setMode(mode: "compact" | "expanded") {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
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
