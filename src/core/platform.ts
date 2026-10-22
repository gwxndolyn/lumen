// Cross-platform capability model. Pure (no Electron imports) so the per-OS behaviour that the
// UI explains to the user is unit-tested for macOS and Windows on any machine.
//
// Each capability states whether it is supported, how it is implemented on that OS, and any
// requirement or limitation. Nothing here claims a capability works without the adapter that
// implements it (see electron/platform.ts) — this is the contract the UI displays.

export type OsId = "darwin" | "win32" | "linux";

export interface Capability {
  supported: boolean;
  /** The documented OS mechanism used. */
  via: string;
  requirement: string | null;
  limitation: string | null;
}

export interface PlatformProfile {
  os: OsId;
  label: string;
  modifier: "⌘" | "Ctrl";
  globalShortcuts: Capability;
  overlay: Capability;
  screenCapture: Capability;
  windowCapture: Capability;
  microphone: Capability;
  systemAudio: Capability;
  secureStorage: Capability;
  notifications: Capability;
  autoUpdate: Capability;
  /** Excluding Lumen's own window from screen capture is intentionally not offered. */
  captureExclusion: Capability;
}

function parseVersion(v: string): number[] {
  return v.split(".").map((x) => Number.parseInt(x, 10) || 0);
}

export function atLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

/** macOS release from the Darwin kernel version (Darwin 22 = macOS 13, 25 = macOS 26). */
export function macosFromDarwin(kernel: string): string {
  const major = parseVersion(kernel)[0] ?? 0;
  if (major >= 25) return `${major + 1}.0`; // macOS 26 "Tahoe" onward uses year-aligned numbering
  if (major >= 20) return `${major - 9}.0`; // Darwin 20 = macOS 11 … Darwin 24 = macOS 15
  return `10.${major - 4}`;
}

/** Windows build from os.release() (e.g. "10.0.22631" → 22631). Windows 11 is build ≥ 22000. */
export function windowsBuild(release: string): number {
  return parseVersion(release)[2] ?? 0;
}

const NO_EXCLUSION: Capability = {
  supported: false,
  via: "—",
  requirement: null,
  limitation:
    "Lumen does not hide itself from screen sharing or recording. The panel is a normal window and appears in shares and recordings like any other app, so others can see when you use it.",
};

export function platformProfile(os: OsId, release: string, opts: { wayland?: boolean; packaged?: boolean; signed?: boolean } = {}): PlatformProfile {
  if (os === "darwin") {
    const mac = macosFromDarwin(release);
    const sysAudio = atLeast(mac, "13.0");
    return {
      os,
      label: `macOS ${mac}`,
      modifier: "⌘",
      globalShortcuts: { supported: true, via: "Carbon RegisterEventHotKey (Electron globalShortcut)", requirement: null, limitation: "Combinations already owned by macOS or another app cannot be registered; Lumen reports these and suggests alternatives." },
      overlay: { supported: true, via: "NSPanel-style floating window (alwaysOnTop 'floating', visible on all Spaces)", requirement: null, limitation: null },
      screenCapture: { supported: true, via: "ScreenCaptureKit / CGWindowList (Electron desktopCapturer)", requirement: "Screen Recording permission (System Settings → Privacy & Security). macOS applies a new grant only after Lumen restarts.", limitation: "DRM-protected video and some secure fields are captured blank." },
      windowCapture: { supported: true, via: "desktopCapturer window sources", requirement: "Screen Recording permission", limitation: "Windows on other Spaces or minimised windows may be blank or missing." },
      microphone: { supported: true, via: "AVFoundation / CoreAudio (getUserMedia)", requirement: "Microphone permission (prompted on first use)", limitation: null },
      systemAudio: sysAudio
        ? { supported: true, via: "ScreenCaptureKit audio loopback (getDisplayMedia, audio: 'loopback')", requirement: "macOS 13 or later and Screen Recording permission", limitation: "Captures all system output, not a single app. Headphones do not change this." }
        : { supported: false, via: "—", requirement: "macOS 13 or later", limitation: `This Mac runs macOS ${mac}. Use a virtual audio device (e.g. BlackHole) and select it as the microphone instead.` },
      secureStorage: { supported: true, via: "macOS Keychain (Electron safeStorage)", requirement: null, limitation: opts.signed ? null : "Unsigned builds may prompt for Keychain access after updates." },
      notifications: { supported: true, via: "UNUserNotificationCenter (Electron Notification)", requirement: "Notification permission", limitation: null },
      autoUpdate: { supported: !!opts.signed, via: "Squirrel.Mac (electron-updater) from a release feed", requirement: "Signed and notarized build plus a configured update feed", limitation: opts.signed ? null : "This build is unsigned, so automatic updates are disabled. Download new versions manually." },
      captureExclusion: NO_EXCLUSION,
    };
  }
  if (os === "win32") {
    const build = windowsBuild(release);
    const win11 = build >= 22000;
    return {
      os,
      label: `Windows ${win11 ? "11" : "10"} (build ${build || "unknown"})`,
      modifier: "Ctrl",
      globalShortcuts: { supported: true, via: "Win32 RegisterHotKey (Electron globalShortcut)", requirement: null, limitation: "Win-key combinations and shortcuts owned by other apps cannot be registered; Lumen reports these and suggests alternatives." },
      overlay: { supported: true, via: "Topmost layered window (WS_EX_TOPMOST)", requirement: null, limitation: "Exclusive-fullscreen games can draw over the panel." },
      screenCapture: { supported: true, via: "Windows.Graphics.Capture / DXGI (Electron desktopCapturer)", requirement: "None (Windows does not prompt)", limitation: "Windows that set display affinity (some password managers, DRM video) capture black; Lumen detects and rejects blank captures." },
      windowCapture: { supported: true, via: "desktopCapturer window sources", requirement: null, limitation: "Minimised windows cannot be captured." },
      microphone: { supported: true, via: "WASAPI (getUserMedia)", requirement: "Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”", limitation: null },
      systemAudio: { supported: true, via: "WASAPI loopback (getDisplayMedia, audio: 'loopback')", requirement: null, limitation: "Captures the default output device mix, not a single app." },
      secureStorage: { supported: true, via: "DPAPI, per-user (Electron safeStorage)", requirement: null, limitation: "Keys are bound to the Windows user account; copying the profile to another PC makes them unreadable (Lumen asks you to re-enter them)." },
      notifications: { supported: true, via: "Windows toast notifications (Electron Notification, AppUserModelID)", requirement: "Installed build (toasts need the Start-menu shortcut created by the installer)", limitation: opts.packaged ? null : "Notifications do not appear in unpackaged development runs." },
      autoUpdate: { supported: !!opts.signed, via: "NSIS + electron-updater from a release feed", requirement: "Code-signed installer plus a configured update feed", limitation: opts.signed ? null : "This build is unsigned: SmartScreen warns on install and automatic updates are disabled." },
      captureExclusion: NO_EXCLUSION,
    };
  }
  const wayland = !!opts.wayland;
  return {
    os: "linux",
    label: wayland ? "Linux (Wayland)" : "Linux (X11)",
    modifier: "Ctrl",
    globalShortcuts: wayland
      ? { supported: false, via: "—", requirement: "X11 session, or a compositor implementing the GlobalShortcuts portal", limitation: "Wayland does not let apps register global shortcuts directly. Use the tray menu, or bind a desktop shortcut to `lumen --toggle`." }
      : { supported: true, via: "X11 XGrabKey (Electron globalShortcut)", requirement: null, limitation: null },
    overlay: { supported: true, via: "Override-redirect / always-on-top window", requirement: null, limitation: wayland ? "Always-on-top depends on the compositor." : null },
    screenCapture: { supported: true, via: wayland ? "xdg-desktop-portal ScreenCast" : "X11 (Electron desktopCapturer)", requirement: wayland ? "The portal asks you to pick a screen for each capture" : null, limitation: null },
    windowCapture: { supported: !wayland, via: wayland ? "—" : "desktopCapturer window sources", requirement: null, limitation: wayland ? "Individual windows are not listed under Wayland." : null },
    microphone: { supported: true, via: "PulseAudio / PipeWire (getUserMedia)", requirement: null, limitation: null },
    systemAudio: { supported: false, via: "—", requirement: null, limitation: "Not supported. Select a PulseAudio/PipeWire “Monitor of …” source as the microphone instead." },
    secureStorage: { supported: true, via: "libsecret / KWallet (Electron safeStorage)", requirement: "A running Secret Service (GNOME Keyring or KWallet)", limitation: "Without one, keys are kept in memory only for the current run." },
    notifications: { supported: true, via: "libnotify (Electron Notification)", requirement: null, limitation: null },
    autoUpdate: { supported: false, via: "AppImage (manual)", requirement: null, limitation: "Update by downloading the new AppImage." },
    captureExclusion: NO_EXCLUSION,
  };
}
