import { BrowserWindow, screen, shell, type Rectangle } from "electron";
import path from "node:path";
import type { Settings, WindowRole } from "../src/shared/types";
import { defaultOverlayRect, moveToDisplay, resolveBounds } from "./geometry";

const DEV_URL = process.env.LUMEN_DEV_URL;

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

export class WindowManager {
  overlay: BrowserWindow | null = null;
  main: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly saveBounds: (b: Settings["overlay"]["bounds"]) => void,
  ) {
    const relayout = () => this.ensureOverlayVisible();
    screen.on("display-removed", relayout);
    screen.on("display-metrics-changed", relayout);
    screen.on("display-added", relayout);
  }

  private displays() {
    return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
  }

  createOverlay(): BrowserWindow {
    const s = this.getSettings();
    const primary = screen.getPrimaryDisplay();
    const rect = s.overlay.bounds
      ? resolveBounds(s.overlay.bounds, this.displays(), { id: primary.id, workArea: primary.workArea })
      : defaultOverlayRect(primary.workArea);
    const win = new BrowserWindow({
      ...rect,
      minWidth: 360,
      minHeight: 120,
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
    win.on("moved", () => this.scheduleSave());
    win.on("resized", () => this.scheduleSave());
    win.on("closed", () => {
      this.overlay = null;
    });
    void win.loadURL(rendererUrl("/overlay"));
    this.overlay = win;
    return win;
  }

  applyOverlaySettings(win: BrowserWindow | null = this.overlay, s: Settings = this.getSettings()) {
    if (!win) return;
    win.setOpacity(s.overlay.opacity);
    // "floating" keeps the panel above normal windows without covering system UI.
    win.setAlwaysOnTop(s.overlay.alwaysOnTop, "floating");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(s.overlay.alwaysOnTop, { visibleOnFullScreen: true });
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const w = this.overlay;
      if (!w || w.isDestroyed()) return;
      const b = w.getBounds();
      const d = screen.getDisplayMatching(b);
      this.saveBounds({ ...b, displayId: d.id });
    }, 400);
  }

  /** Re-clamp the overlay after a monitor is unplugged or rearranged. */
  ensureOverlayVisible() {
    const w = this.overlay;
    if (!w || w.isDestroyed()) return;
    const primary = screen.getPrimaryDisplay();
    const b = w.getBounds();
    const next = resolveBounds(
      { ...b, displayId: screen.getDisplayMatching(b).id },
      this.displays(),
      { id: primary.id, workArea: primary.workArea },
    );
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) {
      w.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
    }
  }

  showOverlay() {
    const w = this.overlay ?? this.createOverlay();
    const s = this.getSettings();
    if (s.overlay.followCursorDisplay) {
      const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const b = w.getBounds();
      const current = screen.getDisplayMatching(b);
      if (current.id !== cursorDisplay.id) w.setBounds(moveToDisplay(b, current.workArea, cursorDisplay.workArea) as Rectangle);
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

  setOverlaySize(width: number, height: number) {
    const w = this.overlay;
    if (!w) return;
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    w.setBounds({ ...b, width: Math.min(Math.max(360, width), area.width), height: Math.min(Math.max(120, height), area.height) });
    this.ensureOverlayVisible();
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
