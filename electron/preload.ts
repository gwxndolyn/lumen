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
  chatSend: invoke("chat:send"),
  chatCancel: invoke("chat:cancel"),
  listConversations: invoke("history:list"),
  getMessages: invoke("history:messages"),
  renameConversation: invoke("history:rename"),
  deleteConversation: invoke("history:delete"),
  search: invoke("history:search"),
  listContext: invoke("context:list"),
  addNote: invoke("context:addNote"),
  addClipboard: invoke("context:addClipboard"),
  addDocuments: invoke("context:addDocuments"),
  updateContext: invoke("context:update"),
  removeContext: invoke("context:remove"),
  clearContext: invoke("context:clear"),
  listCaptureSources: invoke("capture:sources"),
  captureSource: invoke("capture:source"),
  attachCapture: invoke("capture:attach"),
  discardCapture: invoke("capture:discard"),
  quickCapture: invoke("capture:quick"),
  listKnowledge: invoke("kb:list"),
  importKnowledge: invoke("kb:import"),
  addKnowledgeText: invoke("kb:addText"),
  deleteKnowledge: invoke("kb:delete"),
  transcriptStart: invoke("transcript:start"),
  transcriptPause: invoke("transcript:pause"),
  transcriptResume: invoke("transcript:resume"),
  transcriptStop: invoke("transcript:stop"),
  transcriptAudio: (pcm) => ipcRenderer.send("transcript:audio", pcm),
  transcriptCaptureFailed: (message) => ipcRenderer.send("transcript:captureFailed", message),
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
