import type { AnswerStyle, Settings } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Default — strongest everyday model" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster, lower cost" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, lowest cost" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "Most capable, slowest and most expensive" },
] as const;

export const DEFAULT_SHORTCUTS: Settings["shortcuts"] = {
  toggleOverlay: "CommandOrControl+Shift+Space",
  askAboutScreen: "CommandOrControl+Shift+S",
  askAboutSelection: "CommandOrControl+Shift+A",
  openMainWindow: "CommandOrControl+Shift+L",
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
    openaiCompat: { baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  },
  transcription: {
    kind: "deepgram",
    language: "en",
    microphoneDeviceId: null,
    captureSystemAudio: false,
    persist: true,
  },
  assistant: {
    mode: "general",
    style: "quick",
    tone: "neutral",
    useKnowledgeBase: true,
    useConversationHistory: true,
  },
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
