import type { Settings } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Default — strongest everyday model" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster, lower cost" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Fastest, lowest cost" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", note: "Most capable, slowest and most expensive" },
] as const;

export const DEFAULT_SHORTCUTS: Settings["shortcuts"] = {
  toggleOverlay: "CommandOrControl+Shift+Space",
  askAboutScreen: "CommandOrControl+Shift+S",
  openMainWindow: "CommandOrControl+Shift+L",
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  onboardingComplete: false,
  theme: "dark",
  provider: {
    kind: "anthropic",
    model: "claude-opus-5-5",
    // Low effort keeps the overlay snappy; users can raise it for harder questions.
    effort: "low",
    maxTokens: 16000,
    timeoutMs: 120_000,
  },
  transcription: {
    kind: "deepgram",
    language: "en",
    microphoneDeviceId: null,
    captureSystemAudio: false,
  },
  assistant: {
    mode: "general",
    length: "short",
    tone: "neutral",
    useKnowledgeBase: true,
    useConversationHistory: true,
  },
  overlay: {
    opacity: 0.96,
    alwaysOnTop: true,
    bounds: null,
    followCursorDisplay: true,
  },
  shortcuts: DEFAULT_SHORTCUTS,
  privacy: {
    transcriptRetentionDays: 30,
    conversationRetentionDays: 90,
    keepScreenshotsInHistory: false,
  },
  consent: {
    screen: false,
    microphone: false,
    systemAudio: false,
  },
};

export const MODE_LABELS: Record<Settings["assistant"]["mode"], string> = {
  general: "General",
  meeting: "Meeting copilot",
  interview: "Interview practice",
  technical: "Technical explainer",
  coding: "Coding assistant",
};
