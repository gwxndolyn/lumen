import { contextBridge, ipcRenderer } from "electron";
import type { LumenApi } from "../src/shared/api";

const roleArg = process.argv.find((a) => a.startsWith("--lumen-role="));
const role = roleArg?.split("=")[1] === "overlay" ? "overlay" : "main";

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

function subscribe(channel: string) {
  return (fn: (e: never) => void) => {
    const listener = (_: unknown, payload: unknown) => fn(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

// Narrow, typed bridge — the renderer never gets ipcRenderer or Node APIs.
const api: LumenApi = {
  role,
  platform: process.platform,
  getSettings: invoke("settings:get"),
  updateSettings: invoke("settings:update"),
  resetShortcuts: invoke("settings:resetShortcuts"),
  getShortcutStatus: invoke("settings:shortcutStatus"),
  secretsStatus: invoke("secrets:status"),
  setSecret: invoke("secrets:set"),
  clearSecret: invoke("secrets:clear"),
  testProvider: invoke("provider:test"),
  providerHealth: invoke("provider:health"),
  listSessions: invoke("sessions:list"),
  activeSession: invoke("sessions:active"),
  createSession: invoke("sessions:create"),
  updateSession: invoke("sessions:update"),
  switchSession: invoke("sessions:switch"),
  deleteSession: invoke("sessions:delete"),
  exportSession: invoke("sessions:export"),
  chatSend: invoke("chat:send"),
  analyzeProblem: invoke("technical:analyze"),
  getProfile: invoke("profile:get"),
  saveProfile: invoke("profile:save"),
  interviewQuestions: invoke("interview:questions"),
  updateNotes: invoke("notes:update"),
  exportNotes: invoke("notes:export"),
  chatCancel: invoke("chat:cancel"),
  listConversations: invoke("history:list"),
  openConversation: invoke("history:openConversation"),
  setOpenConversation: invoke("history:setOpenConversation"),
  spendToday: invoke("usage:today"),
  appInfo: invoke("app:info"),
  platformProfile: invoke("platform:profile"),
  getMessages: invoke("history:messages"),
  renameConversation: invoke("history:rename"),
  deleteConversation: invoke("history:delete"),
  search: invoke("history:search"),
  listContext: invoke("context:list"),
  addNote: invoke("context:addNote"),
  addClipboard: invoke("context:addClipboard"),
  addSelection: invoke("context:addSelection"),
  addDocuments: invoke("context:addDocuments"),
  updateContext: invoke("context:update"),
  confirmContext: invoke("context:confirm"),
  removeContext: invoke("context:remove"),
  clearContext: invoke("context:clear"),
  captureCapabilities: invoke("capture:capabilities"),
  listCaptureSources: invoke("capture:sources"),
  captureSource: invoke("capture:source"),
  importImage: invoke("capture:importImage"),
  attachCapture: invoke("capture:attach"),
  discardCapture: invoke("capture:discard"),
  quickCapture: invoke("capture:quick"),
  assistPrepare: invoke("assist:prepare"),
  liveScreen: invoke("capture:live"),
  liveScreenState: invoke("capture:liveState"),
  listKnowledge: invoke("kb:list"),
  importKnowledge: invoke("kb:import"),
  addKnowledgeText: invoke("kb:addText"),
  deleteKnowledge: invoke("kb:delete"),
  searchKnowledge: invoke("kb:search"),
  transcriptStart: invoke("transcript:start"),
  transcriptPause: invoke("transcript:pause"),
  transcriptResume: invoke("transcript:resume"),
  transcriptStop: invoke("transcript:stop"),
  transcriptAudio: (pcm) => ipcRenderer.send("transcript:audio", pcm),
  transcriptAudioState: (state) => ipcRenderer.send("transcript:audioState", state),
  transcriptCaptureFailed: (message, kind) => ipcRenderer.send("transcript:captureFailed", message, kind),
  transcriptState: invoke("transcript:state"),
  listTranscripts: invoke("transcript:list"),
  getSegments: invoke("transcript:segments"),
  updateSegment: invoke("transcript:updateSegment"),
  deleteSegment: invoke("transcript:deleteSegment"),
  renameTranscript: invoke("transcript:rename"),
  deleteTranscript: invoke("transcript:delete"),
  generateInsights: invoke("transcript:insights"),
  getInsights: invoke("transcript:getInsights"),
  permissions: invoke("permissions:get"),
  requestMicrophone: invoke("permissions:requestMic"),
  openPermissionSettings: invoke("permissions:open"),
  exportData: invoke("data:export"),
  deleteAllData: invoke("data:deleteAll"),
  diagnostics: invoke("diagnostics:get"),
  openLogs: invoke("diagnostics:openLogs"),
  copyText: invoke("app:copy"),
  openExternal: invoke("app:openExternal"),
  overlay: invoke("overlay:action"),
  openMain: invoke("app:openMain"),
  setOverlaySize: invoke("overlay:setSize"),
  onChat: subscribe("lumen:chat"),
  onTranscript: subscribe("lumen:transcript"),
  onApp: subscribe("lumen:app"),
} as LumenApi;

contextBridge.exposeInMainWorld("lumen", api);
