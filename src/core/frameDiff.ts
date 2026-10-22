// Change detection for live screen sampling: a 16×16 grayscale fingerprint per frame, compared by
// mean absolute difference. Unchanged screens are skipped so they are not re-OCR'd or re-sent.

export const FINGERPRINT_SIZE = 16;
/** Mean per-cell luminance difference (0–255) below which two frames count as unchanged. */
export const CHANGE_THRESHOLD = 3;

/** Fingerprint from a BGRA/RGBA bitmap already downscaled to FINGERPRINT_SIZE². */
export function fingerprint(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const n = FINGERPRINT_SIZE;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / n));
      const sy = Math.min(height - 1, Math.floor((y * height) / n));
      const i = (sy * width + sx) * 4;
      // Channel order (RGBA vs BGRA) doesn't matter for change detection; equal weights suffice.
      out[y * n + x] = Math.round(((bitmap[i] ?? 0) + (bitmap[i + 1] ?? 0) + (bitmap[i + 2] ?? 0)) / 3);
    }
  }
  return out;
}

export function frameDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

export function hasChanged(prev: Uint8Array | null, next: Uint8Array, threshold = CHANGE_THRESHOLD): boolean {
  return !prev || frameDistance(prev, next) >= threshold;
}
