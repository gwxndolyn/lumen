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
