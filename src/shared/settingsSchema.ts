import { z } from "zod";
import { DEFAULT_SETTINGS } from "./defaults";
import type { Settings } from "./types";

const accelerator = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9+.]+$/, "Shortcut may only contain letters, digits and '+'");

const httpUrl = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^\s]+$/, "Must be an http(s) URL");

export const styleEnum = z.enum(["quick", "detailed", "steps", "suggest", "technical", "meeting_summary", "follow_ups"]);
export const modeEnum = z.enum(["general", "meeting", "interview", "technical", "coding"]);
export const effortEnum = z.enum(["low", "medium", "high"]);
export const toneEnum = z.enum(["neutral", "friendly", "formal", "confident"]);

export const settingsSchema = z.object({
  version: z.literal(1),
  onboardingComplete: z.boolean(),
  theme: z.enum(["dark", "light", "system"]),
  activeSessionId: z.string().max(100).nullable(),
  provider: z.object({
    kind: z.enum(["anthropic", "openai_compat", "mock"]),
    model: z.string().regex(/^[a-z0-9.-]{3,64}$/),
    effort: effortEnum,
    maxTokens: z.number().int().min(256).max(64000),
    timeoutMs: z.number().int().min(5_000).max(600_000),
    idleTimeoutMs: z.number().int().min(5_000).max(300_000),
    openaiCompat: z.object({ baseUrl: httpUrl, model: z.string().min(1).max(120) }),
  }),
  transcription: z.object({
    kind: z.enum(["deepgram", "none"]),
    language: z.string().regex(/^[a-zA-Z-]{2,10}$/),
    microphoneDeviceId: z.string().max(512).nullable(),
    captureSystemAudio: z.boolean(),
    persist: z.boolean(),
  }),
  assistant: z.object({
    mode: modeEnum,
    style: styleEnum,
    tone: toneEnum,
    useKnowledgeBase: z.boolean(),
    useConversationHistory: z.boolean(),
  }),
  screen: z.object({
    requirePreview: z.boolean(),
    sendImages: z.boolean(),
    ocr: z.boolean(),
    liveIntervalSec: z.number().int().min(3).max(300),
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
    position: z.enum(["custom", "top-center", "top-right", "bottom-right", "bottom-center"]),
    expandedHeight: z.number().int().min(240).max(2000),
  }),
  shortcuts: z.object({
    toggleOverlay: accelerator,
    askAboutScreen: accelerator,
    askAboutSelection: accelerator,
    openMainWindow: accelerator,
  }),
  privacy: z.object({
    transcriptRetentionDays: z.number().int().min(0).max(3650),
    conversationRetentionDays: z.number().int().min(0).max(3650),
    keepScreenshotsInHistory: z.literal(false),
    redactSensitive: z.boolean(),
    screenContextTtlMinutes: z.number().int().min(1).max(1440),
  }),
  consent: z.object({
    screen: z.boolean(),
    microphone: z.boolean(),
    systemAudio: z.boolean(),
  }),
  diagnostics: z.object({
    logLevel: z.enum(["off", "error", "info", "debug"]),
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

/** v0.1 stored `assistant.length`; map it onto the new answer style. */
function upgradeLegacy(stored: Record<string, unknown>): Record<string, unknown> {
  const a = stored.assistant;
  if (isPlainObject(a) && "length" in a && !("style" in a)) {
    const { length, ...rest } = a;
    return { ...stored, assistant: { ...rest, style: length === "detailed" ? "detailed" : "quick" } };
  }
  return stored;
}

/** Strip keys that are not in the schema so stale fields from older versions do not linger. */
function prune(value: unknown, shape: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(shape)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(shape)) if (k in value) out[k] = prune(value[k], shape[k]);
  return out;
}

/**
 * Load persisted settings. Unknown or invalid stored data falls back to defaults field-by-field
 * so a corrupted value never bricks the app. Returns the repaired settings.
 */
export function loadSettings(stored: unknown): Settings {
  const upgraded = isPlainObject(stored) ? upgradeLegacy(stored) : {};
  const merged = prune(deepMerge(DEFAULT_SETTINGS, upgraded), DEFAULT_SETTINGS) as Settings;
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
