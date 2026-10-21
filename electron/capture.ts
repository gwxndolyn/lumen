import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { desktopCapturer, nativeImage, screen, systemPreferences, type NativeImage } from "electron";
import { isBlankBitmap } from "./geometry";
import type { CaptureCapabilities, CaptureRegion, CaptureSource, OsPermission, PermissionStatus } from "../src/shared/types";

/** Longest edge sent to the vision model; larger images are downscaled (Anthropic guidance). */
const MAX_EDGE = 1568;
/** OCR works best around 2–3k px on the long edge; tiny regions are upscaled. */
const OCR_MIN_EDGE = 1400;
const OCR_MAX_EDGE = 3000;
const PENDING_TTL_MS = 5 * 60_000;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: "permission" | "unavailable" | "protected" | "too_small" | "expired" | "unsupported",
  ) {
    super(message);
  }
}

interface Pending {
  image: NativeImage;
  title: string;
  at: number;
  sourceId: string;
}

export interface FinalizedCapture {
  title: string;
  sourceId: string;
  /** JPEG for the vision model (downscaled). */
  vision: { mediaType: "image/jpeg"; data: string };
  /** PNG for OCR (lossless, size-normalized). */
  ocrPng: Buffer;
  thumbnailDataUrl: string;
  width: number;
  height: number;
}

/**
 * Platform capture backend. Electron's desktopCapturer is the single documented API used on every
 * platform; what differs is permission handling and which windows the OS lets us see.
 */
export interface CaptureBackend {
  capabilities(): CaptureCapabilities;
  listSources(): Promise<CaptureSource[]>;
  captureSource(sourceId: string): Promise<{ image: NativeImage; title: string }>;
  displaySourceAtCursor(): Promise<string>;
}

function mediaStatus(kind: "screen" | "microphone"): OsPermission {
  if (process.platform !== "darwin" && process.platform !== "win32") return "not-required";
  try {
    return systemPreferences.getMediaAccessStatus(kind) as OsPermission;
  } catch {
    return "unknown";
  }
}

const PLATFORM_NOTES: Record<string, string[]> = {
  darwin: [
    "Requires Screen Recording permission (System Settings → Privacy & Security). macOS only applies a newly granted permission after Lumen restarts.",
    "Windows on other Spaces, minimized windows and DRM-protected video appear blank or are not listed.",
  ],
  win32: [
    "No OS permission is required.",
    "Windows that set display affinity (some password managers, DRM video) are captured as black and are rejected.",
    "Minimized windows cannot be captured.",
  ],
  linux: [
    "X11: screens and windows can be captured.",
    "Wayland: capture goes through the desktop portal, which asks you to pick a screen each time; individual windows may not be listed.",
  ],
};

class ElectronCaptureBackend implements CaptureBackend {
  capabilities(): CaptureCapabilities {
    const p = process.platform;
    const permission: OsPermission = p === "darwin" ? mediaStatus("screen") : "not-required";
    const wayland = p === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY);
    return {
      platform: p,
      screens: p === "darwin" || p === "win32" || p === "linux",
      windows: !wayland,
      region: true,
      imageImport: true,
      liveScreen: !wayland,
      ocr: true,
      permission,
      notes: PLATFORM_NOTES[p] ?? ["Screen capture support on this platform is untested."],
    };
  }

  async listSources(): Promise<CaptureSource[]> {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
    return sources
      .filter((s) => !/^Lumen$/.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name || "Untitled window",
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnailDataUrl: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
        displayId: s.display_id || null,
      }));
  }

  async captureSource(sourceId: string) {
    const largest = screen.getAllDisplays().reduce(
      (m, d) => ({ width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)), height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)) }),
      { width: 1920, height: 1080 },
    );
    const sources = await desktopCapturer.getSources({ types: [sourceId.startsWith("screen:") ? "screen" : "window"], thumbnailSize: largest });
    const src = sources.find((s) => s.id === sourceId);
    if (!src) throw new CaptureError("That screen or window is no longer available (it may have closed or been minimized).", "unavailable");
    return { image: src.thumbnail, title: src.name };
  }

  async displaySourceAtCursor(): Promise<string> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src) throw new CaptureError("No screen is available to capture.", "unavailable");
    return src.id;
  }
}

export class CaptureService {
  private pending = new Map<string, Pending>();

  constructor(private readonly backend: CaptureBackend = new ElectronCaptureBackend()) {}

  capabilities() {
    return this.backend.capabilities();
  }

  private assertPermission() {
    const caps = this.backend.capabilities();
    if (caps.permission === "denied" || caps.permission === "restricted") {
      throw new CaptureError(
        "macOS is blocking screen capture. Allow Lumen in System Settings → Privacy & Security → Screen Recording, then restart Lumen.",
        "permission",
      );
    }
  }

  async listSources(): Promise<CaptureSource[]> {
    this.assertPermission();
    return this.backend.listSources();
  }

  private hold(image: NativeImage, title: string, sourceId: string) {
    this.gc();
    if (image.isEmpty()) {
      throw new CaptureError(
        process.platform === "darwin"
          ? "The capture was empty. Grant Screen Recording permission to Lumen in System Settings → Privacy & Security, then restart Lumen."
          : "The capture was empty. The window may be minimised or protected from capture.",
        process.platform === "darwin" ? "permission" : "protected",
      );
    }
    const size = image.getSize();
    if (isBlankBitmap(image.toBitmap(), size.width, size.height)) {
      throw new CaptureError(
        "The capture came back blank. The app may protect its content from capture (DRM, password managers), or screen capture permission is not active yet.",
        "protected",
      );
    }
    const captureId = randomUUID();
    this.pending.set(captureId, { image, title, at: Date.now(), sourceId });
    const preview = image.resize({ width: Math.min(1280, size.width) });
    return { captureId, previewDataUrl: preview.toDataURL(), width: size.width, height: size.height, title };
  }

  /** Capture a source at full resolution; held in memory until attached or discarded. */
  async capture(sourceId: string) {
    this.assertPermission();
    const { image, title } = await this.backend.captureSource(sourceId);
    return this.hold(image, title, sourceId);
  }

  async captureCursorDisplay() {
    this.assertPermission();
    return this.capture(await this.backend.displaySourceAtCursor());
  }

  /** Import an image file the user selected (works on every platform, no capture permission). */
  async importImage(file: string) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new CaptureError(`.${ext} images are not supported.`, "unsupported");
    const buf = await fs.readFile(file);
    if (buf.length > 30 * 1024 * 1024) throw new CaptureError("The image is larger than 30 MB.", "unsupported");
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new CaptureError("The image could not be decoded.", "unsupported");
    return this.hold(img, path.basename(file), `file:${path.basename(file)}`);
  }

  /** Crop (region is in source pixels), then produce a vision JPEG and an OCR-ready PNG. Clears the pending capture. */
  finalize(captureId: string, region: CaptureRegion | null): FinalizedCapture {
    const p = this.pending.get(captureId);
    if (!p) throw new CaptureError("This capture expired. Capture again.", "expired");
    this.pending.delete(captureId);
    let img = p.image;
    if (region) {
      const size = img.getSize();
      const r = { x: Math.max(0, Math.round(region.x)), y: Math.max(0, Math.round(region.y)), width: Math.round(region.width), height: Math.round(region.height) };
      r.width = Math.min(r.width, size.width - r.x);
      r.height = Math.min(r.height, size.height - r.y);
      if (r.width < 8 || r.height < 8) throw new CaptureError("The selected region is too small.", "too_small");
      img = img.crop(r);
    }
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    const vScale = Math.min(1, MAX_EDGE / long);
    const vision = vScale < 1 ? img.resize({ width: Math.round(width * vScale), height: Math.round(height * vScale), quality: "best" }) : img;
    const oScale = long < OCR_MIN_EDGE ? Math.min(3, OCR_MIN_EDGE / long) : long > OCR_MAX_EDGE ? OCR_MAX_EDGE / long : 1;
    const ocrImg = oScale !== 1 ? img.resize({ width: Math.round(width * oScale), height: Math.round(height * oScale), quality: "best" }) : img;
    const thumb = img.resize({ width: Math.min(240, width) });
    return {
      title: p.title,
      sourceId: p.sourceId,
      vision: { mediaType: "image/jpeg", data: vision.toJPEG(85).toString("base64") },
      ocrPng: ocrImg.toPNG(),
      thumbnailDataUrl: thumb.toDataURL(),
      width,
      height,
    };
  }

  discard(captureId: string) {
    this.pending.delete(captureId);
  }

  clearAll() {
    this.pending.clear();
  }

  get pendingCount() {
    return this.pending.size;
  }

  private gc() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
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

export { IMAGE_EXTENSIONS };
