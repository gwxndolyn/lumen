// Platform capability contract for macOS and Windows (and Linux), testable on any host.
import { describe, expect, it } from "vitest";
import { atLeast, macosFromDarwin, platformProfile, windowsBuild } from "../core/platform";
import { canonical } from "../core/shortcuts";
import { formatAccelerator as prettyAccelerator } from "../shared/accelerators";
import { DEFAULT_SHORTCUTS } from "../shared/defaults";

describe("OS version detection", () => {
  it("maps Darwin kernels to macOS versions", () => {
    expect(macosFromDarwin("20.6.0")).toBe("11.0");
    expect(macosFromDarwin("22.1.0")).toBe("13.0");
    expect(macosFromDarwin("24.0.0")).toBe("15.0");
    expect(macosFromDarwin("25.6.0")).toBe("26.0");
    expect(atLeast("13.0", "13.0")).toBe(true);
    expect(atLeast("12.7", "13.0")).toBe(false);
  });
  it("reads Windows build numbers", () => {
    expect(windowsBuild("10.0.22631")).toBe(22631);
    expect(windowsBuild("10.0.19045")).toBe(19045);
  });
});

describe("macOS profile", () => {
  it("requires Screen Recording permission and macOS 13 for system audio", () => {
    const p = platformProfile("darwin", "25.6.0");
    expect(p.modifier).toBe("⌘");
    expect(p.screenCapture.requirement).toMatch(/Screen Recording/);
    expect(p.systemAudio.supported).toBe(true);
    expect(platformProfile("darwin", "21.6.0").systemAudio).toMatchObject({ supported: false, requirement: "macOS 13 or later" });
    expect(p.secureStorage.via).toMatch(/Keychain/);
  });
});

describe("Windows profile", () => {
  it("uses WASAPI loopback, DPAPI and RegisterHotKey; no screen permission prompt", () => {
    const p = platformProfile("win32", "10.0.22631", { packaged: true });
    expect(p.label).toBe("Windows 11 (build 22631)");
    expect(platformProfile("win32", "10.0.19045").label).toMatch(/^Windows 10/);
    expect(p.modifier).toBe("Ctrl");
    expect(p.systemAudio).toMatchObject({ supported: true });
    expect(p.systemAudio.via).toMatch(/WASAPI loopback/);
    expect(p.secureStorage.via).toMatch(/DPAPI/);
    expect(p.globalShortcuts.via).toMatch(/RegisterHotKey/);
    expect(p.screenCapture.requirement).toMatch(/does not prompt/);
  });
  it("disables auto-update and warns about SmartScreen when unsigned", () => {
    expect(platformProfile("win32", "10.0.22631").autoUpdate).toMatchObject({ supported: false });
    expect(platformProfile("win32", "10.0.22631").autoUpdate.limitation).toMatch(/SmartScreen/);
    expect(platformProfile("win32", "10.0.22631", { signed: true }).autoUpdate.supported).toBe(true);
  });
});

describe("Linux profile", () => {
  it("explains Wayland limitations instead of pretending", () => {
    const w = platformProfile("linux", "6.8.0", { wayland: true });
    expect(w.globalShortcuts.supported).toBe(false);
    expect(w.windowCapture.supported).toBe(false);
    expect(w.systemAudio.supported).toBe(false);
    expect(platformProfile("linux", "6.8.0").globalShortcuts.supported).toBe(true);
  });
});

describe("no capture exclusion on any platform", () => {
  it("never claims the panel is hidden from screen sharing", () => {
    for (const os of ["darwin", "win32", "linux"] as const) {
      const p = platformProfile(os, os === "win32" ? "10.0.22631" : "25.0.0");
      expect(p.captureExclusion.supported).toBe(false);
      expect(p.captureExclusion.limitation).toMatch(/appears in shares/);
    }
  });
});

describe("modifier mapping per platform", () => {
  it("defaults resolve to ⌘ on macOS and Ctrl on Windows, displayed correctly", () => {
    expect(canonical(DEFAULT_SHORTCUTS.requestAssist, "darwin")).toBe("cmd+enter");
    expect(canonical(DEFAULT_SHORTCUTS.requestAssist, "win32")).toBe("ctrl+enter");
    expect(canonical(DEFAULT_SHORTCUTS.toggleOverlay, "win32")).toBe("ctrl+\\");
    expect(prettyAccelerator(DEFAULT_SHORTCUTS.requestAssist, "darwin")).toBe("⌘↵");
    expect(prettyAccelerator(DEFAULT_SHORTCUTS.requestAssist, "win32")).toBe("Ctrl+Enter");
    expect(prettyAccelerator(DEFAULT_SHORTCUTS.discreetInput, "win32")).toBe("Ctrl+Shift+Enter");
    expect(prettyAccelerator(DEFAULT_SHORTCUTS.moveLeft, "darwin")).toBe("⌘←");
    expect(prettyAccelerator(DEFAULT_SHORTCUTS.toggleOverlay, "win32")).toBe("Ctrl+\\");
  });
});
