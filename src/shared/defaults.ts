import type { AnswerStyle, Settings } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Default — strongest everyday model" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster, lower cost" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, lowest cost" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "Most capable, slowest and most expensive" },
] as const;

/**
 * Defaults follow Cluely's documented conventions (⌘ on macOS, Ctrl on Windows/Linux). Arrow-key
 * shortcuts are only registered while the panel is visible (see core/shortcuts.ts SHORTCUT_SCOPE).
 */
export const DEFAULT_SHORTCUTS: Settings["shortcuts"] = {
  requestAssist: "CommandOrControl+Enter",
  toggleOverlay: "CommandOrControl+\\",
  scrollUp: "CommandOrControl+Up",
  scrollDown: "CommandOrControl+Down",
  moveLeft: "CommandOrControl+Left",
  moveRight: "CommandOrControl+Right",
  discreetInput: "CommandOrControl+Shift+Enter",
  askAboutScreen: "CommandOrControl+Shift+S",
  askAboutSelection: "CommandOrControl+Shift+A",
  openMainWindow: "CommandOrControl+Shift+L",
  cancelResponse: "CommandOrControl+Shift+Backspace",
  toggleAudio: "CommandOrControl+Shift+M",
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  onboardingComplete: false,
  theme: "dark",
  activeSessionId: null,
  provider: {
    kind: "anthropic",
    model: "claude-opus-5-5",
    // Low effort keeps the overlay snappy; users can raise it for harder questions.
    effort: "low",
    maxTokens: 16000,
    timeoutMs: 120_000,
    idleTimeoutMs: 45_000,
    openaiCompat: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", supportsImages: false },
    openai: { model: "gpt-5" },
    gemini: { model: "gemini-2.5-flash" },
    dailySpendLimitUsd: 5,
    routing: "off",
    customPrice: null,
  },
  transcription: {
    kind: "deepgram",
    language: "en",
    microphoneDeviceId: null,
    captureSystemAudio: false,
    persist: true,
    vocabulary: [],
  },
  assistant: {
    mode: "general",
    style: "quick",
    tone: "neutral",
    useKnowledgeBase: true,
    useConversationHistory: true,
    useProjectMemory: true,
  },
  questions: { policy: "assisted" },
  personalization: { depth: "quick", alsoKnows: [], codeStyle: "idiomatic", hintsFirst: false, includeComplexity: true, includeTests: true },
  interview: { length: "short", interviewer: "any" },
  technical: { language: "python", level: "mid", detail: "concise" },
  screen: {
    requirePreview: true,
    sendImages: true,
    ocr: true,
    liveIntervalSec: 10,
  },
  overlay: {
    opacity: 0.96,
    alwaysOnTop: true,
    bounds: null,
    followCursorDisplay: true,
    position: "top-center",
    expandedHeight: 520,
  },
  shortcuts: DEFAULT_SHORTCUTS,
  privacy: {
    transcriptRetentionDays: 30,
    conversationRetentionDays: 90,
    keepScreenshotsInHistory: false,
    redactSensitive: true,
    screenContextTtlMinutes: 15,
  },
  consent: {
    screen: false,
    microphone: false,
    systemAudio: false,
  },
  diagnostics: {
    logLevel: "info",
  },
  inference: {
    mode: "manual",
    local: { baseUrl: "http://127.0.0.1:11434", model: "", numCtx: 8192, embeddingModel: "" },
    privacyRestricted: false,
    cloudAllowed: { screen: false, transcript: false, documents: false },
    fallback: { cloudToLocal: true, localToCloud: false },
    responseCache: false,
  },
  limits: {
    requestsPerSession: 0,
    costPerSessionUsd: 0,
    warnAtPercent: 80,
    maxConcurrentRequests: 3,
    maxContextChars: 60_000,
    maxAttempts: 4,
    retryTimeouts: false,
  },
};

export const MODE_LABELS: Record<Settings["assistant"]["mode"], string> = {
  general: "General",
  meeting: "Meeting",
  interview: "Interview practice",
  technical: "Technical",
  coding: "Coding",
};

export const STYLE_LABELS: Record<AnswerStyle, string> = {
  quick: "Quick answer",
  detailed: "Detailed explanation",
  steps: "Step-by-step",
  suggest: "Suggested response",
  technical: "Technical explanation",
  meeting_summary: "Meeting summary",
  follow_ups: "Follow-up questions",
};

/**
 * Model presets per provider. Users can type any model id their account supports; presets only
 * fill the picker. Image support is per provider family and decides whether screenshots are sent
 * as images or as recognized text only.
 */
export const PROVIDER_INFO: Record<"anthropic" | "openai" | "gemini" | "openai_compat", { label: string; keyUrl: string; models: string[]; supportsImages: boolean; host: string }> = {
  anthropic: { label: "Anthropic Claude", keyUrl: "https://console.anthropic.com/settings/keys", models: MODELS.map((m) => m.id), supportsImages: true, host: "api.anthropic.com" },
  openai: { label: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"], supportsImages: true, host: "api.openai.com" },
  gemini: { label: "Google Gemini", keyUrl: "https://aistudio.google.com/apikey", models: ["gemini-2.5-pro", "gemini-2.5-flash"], supportsImages: true, host: "generativelanguage.googleapis.com" },
  openai_compat: { label: "Custom (OpenAI-compatible)", keyUrl: "", models: [], supportsImages: false, host: "" },
};

/** The model id actually used for the configured provider. */
export function activeModel(p: { kind: string; model: string; openai: { model: string }; gemini: { model: string }; openaiCompat: { model: string } }, override?: string): string {
  switch (p.kind) {
    case "openai":
      return override && !override.startsWith("claude") ? override : p.openai.model;
    case "gemini":
      return override && override.startsWith("gemini") ? override : p.gemini.model;
    case "openai_compat":
      return p.openaiCompat.model;
    case "ollama":
      // The local model lives in settings.inference.local; callers resolve it via inferenceModel().
      return "local";
    case "mock":
      return "mock";
    default:
      return override && override.startsWith("claude") ? override : p.model;
  }
}

/** The model id for the provider kind actually used, including the local runtime. */
export function inferenceModel(s: { provider: Parameters<typeof activeModel>[0]; inference: { local: { model: string } } }, kind: string, override?: string): string {
  return kind === "ollama" ? s.inference.local.model : activeModel({ ...s.provider, kind }, override);
}
