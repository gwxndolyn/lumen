import { z } from "zod";
import { DEFAULT_SETTINGS } from "./defaults";
import type { Settings } from "./types";

const accelerator = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9+]+$/, "Shortcut may only contain letters, digits and '+'");

export const settingsSchema = z.object({
  version: z.literal(1),
  onboardingComplete: z.boolean(),
  theme: z.enum(["dark", "light", "system"]),
  provider: z.object({
    kind: z.enum(["anthropic", "mock"]),
    model: z.string().regex(/^[a-z0-9.-]{3,64}$/),
    effort: z.enum(["low", "medium", "high"]),
    maxTokens: z.number().int().min(256).max(64000),
    timeoutMs: z.number().int().min(5_000).max(600_000),
  }),
  transcription: z.object({
    kind: z.enum(["deepgram", "none"]),
    language: z.string().regex(/^[a-zA-Z-]{2,10}$/),
    microphoneDeviceId: z.string().max(512).nullable(),
    captureSystemAudio: z.boolean(),
  }),
  assistant: z.object({
    mode: z.enum(["general", "meeting", "interview", "technical", "coding"]),
    length: z.enum(["short", "detailed"]),
    tone: z.enum(["neutral", "friendly", "formal", "confident"]),
    useKnowledgeBase: z.boolean(),
    useConversationHistory: z.boolean(),
  }),
  overlay: z.object({
    opacity: z.number().min(0.4).max(1),
    alwaysOnTop: z.boolean(),
    bounds: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(320).max(4000),
        height: z.number().int().min(120).max(4000),
        displayId: z.number().nullable(),
      })
      .nullable(),
    followCursorDisplay: z.boolean(),
  }),
  shortcuts: z.object({
    toggleOverlay: accelerator,
    askAboutScreen: accelerator,
    openMainWindow: accelerator,
  }),
  privacy: z.object({
    transcriptRetentionDays: z.number().int().min(0).max(3650),
    conversationRetentionDays: z.number().int().min(0).max(3650),
    keepScreenshotsInHistory: z.literal(false),
  }),
  consent: z.object({
    screen: z.boolean(),
    microphone: z.boolean(),
    systemAudio: z.boolean(),
  }),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` onto `base`. Arrays and primitives in the patch replace base values. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = k in out && isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/**
 * Load persisted settings. Unknown or invalid stored data falls back to defaults field-by-field
 * so a corrupted value never bricks the app. Returns the repaired settings.
 */
export function loadSettings(stored: unknown): Settings {
  const merged = deepMerge(DEFAULT_SETTINGS, isPlainObject(stored) ? stored : {});
  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data as Settings;
  // Repair: drop every top-level section that failed validation.
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const repaired: Record<string, unknown> = { ...merged };
  for (const key of bad) repaired[key] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
  const second = settingsSchema.safeParse(repaired);
  return second.success ? (second.data as Settings) : structuredClone(DEFAULT_SETTINGS);
}

/** Apply a user patch; throws a readable error if the result would be invalid. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  const merged = deepMerge(current, patch);
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid setting ${issue?.path.join(".")}: ${issue?.message}`);
  }
  return parsed.data as Settings;
}
