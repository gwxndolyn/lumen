// Pure geometry helpers for multi-monitor overlay placement (unit-tested, no Electron imports).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Keep `rect` fully inside `area`, shrinking it if needed. */
export function clampToArea(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Resolve where a saved overlay rect should go given the current monitor layout. If its display
 * was disconnected or the rect is mostly off-screen, it moves to the display it overlaps most
 * (or the fallback display) and is clamped inside the work area.
 */
export function resolveBounds(saved: Rect & { displayId?: number | null }, displays: DisplayLike[], fallback: DisplayLike): Rect & { displayId: number } {
  let best: DisplayLike | undefined = displays.find((d) => d.id === saved.displayId);
  if (!best || intersection(saved, best.workArea) < saved.width * saved.height * 0.5) {
    let bestArea = 0;
    for (const d of displays) {
      const a = intersection(saved, d.workArea);
      if (a > bestArea) {
        bestArea = a;
        best = d;
      }
    }
    if (!bestArea) best = fallback;
  }
  const target = best ?? fallback;
  return { ...clampToArea(saved, target.workArea), displayId: target.id };
}

/** Default overlay position: top-centre of the display's work area. */
export function defaultOverlayRect(area: Rect, width = 560, height = 420): Rect {
  return clampToArea({ x: area.x + Math.round((area.width - width) / 2), y: area.y + 48, width, height }, area);
}

/** Move a rect from one display to the same relative position on another. */
export function moveToDisplay(rect: Rect, from: Rect, to: Rect): Rect {
  const rx = from.width > rect.width ? (rect.x - from.x) / (from.width - rect.width) : 0.5;
  const ry = from.height > rect.height ? (rect.y - from.y) / (from.height - rect.height) : 0;
  return clampToArea(
    {
      x: to.x + Math.max(0, Math.min(1, rx)) * Math.max(0, to.width - rect.width),
      y: to.y + Math.max(0, Math.min(1, ry)) * Math.max(0, to.height - rect.height),
      width: rect.width,
      height: rect.height,
    },
    to,
  );
}

export type Preset = "top-center" | "top-right" | "bottom-right" | "bottom-center";

/** Place a rect of the given size at a named position inside a work area (with a margin). */
export function presetRect(area: Rect, preset: Preset, width: number, height: number, margin = 24): Rect {
  const w = Math.min(width, area.width - margin * 2);
  const h = Math.min(height, area.height - margin * 2);
  const cx = area.x + Math.round((area.width - w) / 2);
  const right = area.x + area.width - w - margin;
  const top = area.y + margin;
  const bottom = area.y + area.height - h - margin;
  const pos: Record<Preset, { x: number; y: number }> = {
    "top-center": { x: cx, y: top },
    "top-right": { x: right, y: top },
    "bottom-right": { x: right, y: bottom },
    "bottom-center": { x: cx, y: bottom },
  };
  return clampToArea({ ...pos[preset], width: w, height: h }, area);
}

/**
 * Resize while keeping the edge nearest the screen edge anchored, so a bottom-docked panel grows
 * upward instead of running off-screen.
 */
export function resizeAnchored(rect: Rect, area: Rect, width: number, height: number): Rect {
  const bottomGap = area.y + area.height - (rect.y + rect.height);
  const topGap = rect.y - area.y;
  const y = bottomGap < topGap ? rect.y + rect.height - height : rect.y;
  return clampToArea({ x: rect.x, y, width, height }, area);
}

/** True when an image is (almost) a single flat colour — what blocked/protected captures look like. */
export function isBlankBitmap(bitmap: Uint8Array, width: number, height: number): boolean {
  if (!width || !height || bitmap.length < 4) return true;
  const step = Math.max(1, Math.floor((width * height) / 4000));
  const r0 = bitmap[0]!;
  const g0 = bitmap[1]!;
  const b0 = bitmap[2]!;
  let differing = 0;
  let samples = 0;
  for (let px = 0; px < width * height; px += step) {
    const i = px * 4;
    if (i + 2 >= bitmap.length) break;
    samples++;
    if (Math.abs(bitmap[i]! - r0) + Math.abs(bitmap[i + 1]! - g0) + Math.abs(bitmap[i + 2]! - b0) > 24) differing++;
  }
  return samples > 0 && differing / samples < 0.002;
}
