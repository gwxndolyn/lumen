import { app, Notification } from "electron";
import os from "node:os";
import { platformProfile, type OsId, type PlatformProfile } from "../src/core/platform";

/**
 * Platform adapter for the Electron main process. Shared logic stays in src/core; anything whose
 * behaviour differs per OS (identity, notifications, capability reporting) lives here.
 */
export const APP_USER_MODEL_ID = "dev.lumen.assistant";

let cached: PlatformProfile | null = null;

export function currentPlatform(): PlatformProfile {
  if (cached) return cached;
  const id = (["darwin", "win32"].includes(process.platform) ? process.platform : "linux") as OsId;
  cached = platformProfile(id, os.release(), {
    wayland: process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY,
    packaged: app.isPackaged,
    // Signing status is set by the release pipeline; local builds are unsigned.
    signed: process.env.LUMEN_SIGNED_BUILD === "1",
  });
  return cached;
}

/** Must run before app.whenReady() on Windows so notifications and taskbar grouping work. */
export function initPlatformIdentity() {
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
}

/** Non-intrusive OS notification (e.g. answer ready while the panel is hidden). */
export function notify(title: string, body: string, onClick?: () => void): boolean {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body: body.slice(0, 200), silent: true });
  if (onClick) n.on("click", onClick);
  n.show();
  return true;
}

/** `lumen --toggle` from a second launch toggles the panel (Wayland / desktop-shortcut fallback). */
export function wantsToggle(argv: string[]): boolean {
  return argv.includes("--toggle");
}
