import { z } from "zod";
import { DEFAULT_SETTINGS } from "./defaults";
import type { Settings } from "./types";

const accelerator = z
  .string()
  .max(64)
  .regex(/^$|^[A-Za-z0-9+.\\[\];',/`=-]+$/, "Shortcut contains unsupported characters");

const httpUrl = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^\s]+$/, "Must be an http(s) URL");

export const styleEnum = z.enum(["quick", "detailed", "steps", "suggest", "technical", "meeting_summary", "follow_ups"]);
export const langEnum = z.enum(["python", "java", "javascript", "typescript", "cpp", "sql", "go", "csharp", "kotlin", "rust"]);
export const modeEnum = z.enum(["general", "meeting", "interview", "technical", "coding"]);
export const effortEnum = z.enum(["low", "medium", "high"]);
export const toneEnum = z.enum(["neutral", "friendly", "formal", "confident"]);

export const settingsSchema = z.object({
  version: z.literal(1),
  onboardingComplete: z.boolean(),
  onboardingStep: z.number().int().min(0).max(10),
  theme: z.enum(["dark", "light", "system"]),
  activeSessionId: z.string().max(100).nullable(),
  provider: z.object({
    kind: z.enum(["anthropic", "openai", "gemini", "openai_compat", "ollama", "mock"]),
    model: z.string().regex(/^[a-z0-9.-]{3,64}$/),
    effort: effortEnum,
    maxTokens: z.number().int().min(256).max(64000),
    timeoutMs: z.number().int().min(5_000).max(600_000),
    idleTimeoutMs: z.number().int().min(5_000).max(300_000),
    openaiCompat: z.object({ baseUrl: httpUrl, model: z.string().min(1).max(120), supportsImages: z.boolean() }),
    openai: z.object({ model: z.string().regex(/^[A-Za-z0-9._:-]{2,80}$/) }),
    gemini: z.object({ model: z.string().regex(/^[A-Za-z0-9._:-]{2,80}$/) }),
    dailySpendLimitUsd: z.number().min(0).max(10_000),
    routing: z.enum(["off", "economy"]),
    customPrice: z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) }).nullable(),
  }),
  transcription: z.object({
    kind: z.enum(["deepgram", "none"]),
    language: z.string().regex(/^[a-zA-Z-]{2,10}$/),
    microphoneDeviceId: z.string().max(512).nullable(),
    captureSystemAudio: z.boolean(),
    persist: z.boolean(),
    vocabulary: z.array(z.string().trim().min(1).max(60)).max(100),
  }),
  assistant: z.object({
    mode: modeEnum,
    style: styleEnum,
    tone: toneEnum,
    useKnowledgeBase: z.boolean(),
    useConversationHistory: z.boolean(),
    useProjectMemory: z.boolean(),
  }),
  questions: z.object({
    policy: z.enum(["manual", "assisted"]),
  }),
  personalization: z.object({
    depth: z.enum(["quick", "balanced", "deep"]),
    alsoKnows: z.array(langEnum).max(10),
    codeStyle: z.enum(["idiomatic", "commented", "compact"]),
    hintsFirst: z.boolean(),
    includeComplexity: z.boolean(),
    includeTests: z.boolean(),
  }),
  interview: z.object({
    length: z.enum(["short", "medium", "detailed"]),
    interviewer: z.enum(["remote", "any"]),
  }),
  technical: z.object({
    language: langEnum,
    level: z.enum(["junior", "mid", "senior"]),
    detail: z.enum(["concise", "full"]),
  }),
  screen: z.object({
    requirePreview: z.boolean(),
    sendImages: z.boolean(),
    ocr: z.boolean(),
    liveIntervalSec: z.number().int().min(3).max(300),
  }),
  mainWindow: z.object({
    bounds: z
      .object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(400).max(10000),
        height: z.number().int().min(300).max(10000),
        displayId: z.number().nullable(),
      })
      .nullable(),
    maximized: z.boolean(),
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
    requestAssist: accelerator,
    toggleOverlay: accelerator,
    scrollUp: accelerator,
    scrollDown: accelerator,
    moveLeft: accelerator,
    moveRight: accelerator,
    discreetInput: accelerator,
    askAboutScreen: accelerator,
    askAboutSelection: accelerator,
    openMainWindow: accelerator,
    cancelResponse: accelerator,
    toggleAudio: accelerator,
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
  inference: z.object({
    mode: z.enum(["manual", "local_first", "cloud_first"]),
    local: z.object({
      baseUrl: z
        .string()
        .max(200)
        .regex(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/?$/, "Must be a loopback address such as http://127.0.0.1:11434"),
      model: z
        .string()
        .max(120)
        .regex(/^$|^[A-Za-z0-9._:/-]+$/),
      numCtx: z.number().int().min(2048).max(131_072),
      embeddingModel: z
        .string()
        .max(120)
        .regex(/^$|^[A-Za-z0-9._:/-]+$/),
    }),
    privacyRestricted: z.boolean(),
    cloudAllowed: z.object({ screen: z.boolean(), transcript: z.boolean(), documents: z.boolean() }),
    fallback: z.object({ cloudToLocal: z.boolean(), localToCloud: z.boolean() }),
    responseCache: z.boolean(),
  }),
  limits: z.object({
    requestsPerSession: z.number().int().min(0).max(100_000),
    costPerSessionUsd: z.number().min(0).max(10_000),
    warnAtPercent: z.number().int().min(10).max(100),
    maxConcurrentRequests: z.number().int().min(1).max(10),
    maxContextChars: z.number().int().min(4_000).max(200_000),
    maxAttempts: z.number().int().min(1).max(6),
    retryTimeouts: z.boolean(),
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

/** Upgrade settings written by older versions. */
function upgradeLegacy(stored: Record<string, unknown>): Record<string, unknown> {
  let out = stored;
  const a = out.assistant;
  // v0.1 stored `assistant.length`; map it onto the answer style.
  if (isPlainObject(a) && "length" in a && !("style" in a)) {
    const { length, ...rest } = a;
    out = { ...out, assistant: { ...rest, style: length === "detailed" ? "detailed" : "quick" } };
  }
  // ≤0.3 had interview.autoSuggest; it became the question policy with the same behaviour.
  const iv = out.interview;
  if (isPlainObject(iv) && "autoSuggest" in iv && !isPlainObject(out.questions)) {
    out = { ...out, questions: { policy: iv.autoSuggest === false ? "manual" : "assisted" } };
  }
  // ≤0.2 toggled the panel with ⌘/Ctrl+Shift+Space. Keep a user's custom choice; move the old
  // default to the new ⌘/Ctrl+\ default.
  const sc = out.shortcuts;
  if (isPlainObject(sc) && sc.toggleOverlay === "CommandOrControl+Shift+Space" && !("requestAssist" in sc)) {
    out = { ...out, shortcuts: { ...sc, toggleOverlay: DEFAULT_SETTINGS.shortcuts.toggleOverlay } };
  }
  return out;
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

/** Parse persisted settings text; corrupt JSON yields defaults rather than a startup crash. */
export function loadSettingsJson(raw: string | null): Settings {
  if (!raw) return loadSettings(null);
  try {
    return loadSettings(JSON.parse(raw));
  } catch {
    return loadSettings(null);
  }
}
