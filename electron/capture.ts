import { randomUUID } from "node:crypto";
import { desktopCapturer, screen, systemPreferences, type NativeImage } from "electron";
import type { CaptureRegion, CaptureSource, OsPermission, PermissionStatus } from "../src/shared/types";

/** Longest edge sent to the vision model; larger images are downscaled (Anthropic guidance). */
const MAX_EDGE = 1568;
const PENDING_TTL_MS = 5 * 60_000;

interface Pending {
  image: NativeImage;
  title: string;
  at: number;
}

export class CaptureService {
  private pending = new Map<string, Pending>();

  async listSources(): Promise<CaptureSource[]> {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((s) => !/^Lumen$/.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name || "Untitled window",
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        displayId: s.display_id || null,
      }));
  }

  /** Capture a source at full resolution; held in memory until attached or discarded. */
  async capture(sourceId: string): Promise<{ captureId: string; previewDataUrl: string; width: number; height: number }> {
    this.gc();
    const largest = screen.getAllDisplays().reduce(
      (m, d) => ({
        width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)),
        height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)),
      }),
      { width: 1920, height: 1080 },
    );
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: largest });
    const src = sources.find((s) => s.id === sourceId);
    if (!src) throw new Error("That screen or window is no longer available.");
    if (src.thumbnail.isEmpty()) {
      throw new Error(
        process.platform === "darwin"
          ? "The capture was empty. Grant Screen Recording permission to Lumen in System Settings → Privacy & Security, then restart Lumen."
          : "The capture was empty. The window may be minimised or protected from capture.",
      );
    }
    const captureId = randomUUID();
    this.pending.set(captureId, { image: src.thumbnail, title: src.name, at: Date.now() });
    const size = src.thumbnail.getSize();
    const preview = src.thumbnail.resize({ width: Math.min(1280, size.width) });
    return { captureId, previewDataUrl: preview.toDataURL(), width: size.width, height: size.height };
  }

  /** Capture the display under the cursor (used by the "ask about screen" shortcut). */
  async captureCursorDisplay(): Promise<string> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src) throw new Error("No screen is available to capture.");
    return (await this.capture(src.id)).captureId;
  }

  /** Crop (region is in source pixels), downscale and encode for the model. Clears the pending capture. */
  finalize(captureId: string, region: CaptureRegion | null): { mediaType: "image/jpeg"; data: string; title: string } {
    const p = this.pending.get(captureId);
    if (!p) throw new Error("This capture expired. Capture again.");
    this.pending.delete(captureId);
    let img = p.image;
    if (region) {
      const size = img.getSize();
      const r = {
        x: Math.max(0, Math.round(region.x)),
        y: Math.max(0, Math.round(region.y)),
        width: Math.round(region.width),
        height: Math.round(region.height),
      };
      r.width = Math.min(r.width, size.width - r.x);
      r.height = Math.min(r.height, size.height - r.y);
      if (r.width < 8 || r.height < 8) throw new Error("The selected region is too small.");
      img = img.crop(r);
    }
    const { width, height } = img.getSize();
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" });
    return { mediaType: "image/jpeg", data: img.toJPEG(85).toString("base64"), title: p.title };
  }

  discard(captureId: string) {
    this.pending.delete(captureId);
  }

  clearAll() {
    this.pending.clear();
  }

  private gc() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
  }
}

function mediaStatus(kind: "screen" | "microphone"): OsPermission {
  if (process.platform !== "darwin" && process.platform !== "win32") return "not-required";
  try {
    return systemPreferences.getMediaAccessStatus(kind) as OsPermission;
  } catch {
    return "unknown";
  }
}

export function permissionStatus(): PermissionStatus {
  return {
    screen: process.platform === "win32" ? "not-required" : mediaStatus("screen"),
    microphone: mediaStatus("microphone"),
    // Loopback system-audio capture is available on Windows and macOS 13+; not on Linux.
    systemAudioSupported: process.platform === "win32" || process.platform === "darwin",
    platform: process.platform,
  };
}

export async function requestMicrophone(): Promise<PermissionStatus> {
  if (process.platform === "darwin") await systemPreferences.askForMediaAccess("microphone");
  return permissionStatus();
}

export function permissionSettingsUrl(kind: "screen" | "microphone"): string | null {
  if (process.platform === "darwin") {
    return kind === "screen"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  }
  if (process.platform === "win32") return kind === "microphone" ? "ms-settings:privacy-microphone" : null;
  return null;
}
