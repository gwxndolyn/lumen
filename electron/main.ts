import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppCore } from "../src/core/app";
import { TesseractOcr } from "../src/core/ocr";
import { SUPPORTED_DOC_EXTENSIONS, extractDocumentText } from "../src/core/knowledge";
import { Store } from "../src/core/storage/db";
import type { AppEvent } from "../src/shared/api";
import { loadSettings, modeEnum, styleEnum, toneEnum, effortEnum } from "../src/shared/settingsSchema";
import type { AudioInputState, Diagnostics, Settings } from "../src/shared/types";
import { CaptureService, IMAGE_EXTENSIONS, permissionSettingsUrl, permissionStatus, requestMicrophone } from "./capture";
import { Logger } from "./logger";
import { SecretStore } from "./secrets";
import { isTrustedUrl, WindowManager } from "./windows";

// Isolated profile for automated smoke tests.
if (process.env.LUMEN_USER_DATA) app.setPath("userData", process.env.LUMEN_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath("userData");
const logger = new Logger(path.join(userData, "logs"));
const secrets = new SecretStore(userData, safeStorage);
const capture = new CaptureService();
const shortcutStatus: Record<string, boolean> = {};
let store: Store;
let core: AppCore;
let windows: WindowManager;
let tray: Tray | null = null;
/** Latest microphone/system-audio state reported by the overlay renderer (for diagnostics). */
let audioState: AudioInputState | null = null;
export const getAudioState = () => audioState;

function emitApp(e: AppEvent) {
  windows?.broadcast("lumen:app", e);
  if (e.type === "settings") {
    windows?.applyOverlaySettings();
    logger.level = e.settings.diagnostics.logLevel;
  }
}

// ---------------- shortcuts ----------------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const map: [keyof Settings["shortcuts"], () => void][] = [
    ["toggleOverlay", () => windows.toggleOverlay()],
    ["askAboutScreen", () => void askAboutScreen()],
    ["askAboutSelection", () => void askAboutSelection()],
    ["openMainWindow", () => windows.openMain()],
  ];
  for (const [name, fn] of map) {
    const acc = core.settings.shortcuts[name];
    let ok = false;
    try {
      ok = globalShortcut.register(acc, fn);
    } catch {
      ok = false;
    }
    shortcutStatus[name] = ok;
    if (!ok) logger.warn("shortcut registration failed", { name, accelerator: acc });
  }
}

function toast(level: "info" | "error", message: string) {
  emitApp({ type: "toast", level, message });
}

async function captureAndAttach(sourceId: string | null, region: null = null) {
  const wasVisible = windows.overlay?.isVisible();
  windows.hideOverlay(); // never capture our own panel
  await new Promise((r) => setTimeout(r, 150));
  try {
    const held = sourceId ? await capture.capture(sourceId) : await capture.captureCursorDisplay();
    const f = capture.finalize(held.captureId, region);
    return core.addCapture({ title: `Screen — ${f.title}`, sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl }).record;
  } finally {
    if (wasVisible !== false) windows.showOverlay();
  }
}

async function askAboutScreen() {
  if (!core.settings.consent.screen) {
    windows.openMain("/main/permissions");
    toast("info", "Enable screen context in Permissions first.");
    return;
  }
  try {
    await captureAndAttach(null);
    windows.showOverlay();
  } catch (err) {
    windows.showOverlay();
    toast("error", (err as Error).message);
  }
}

/**
 * Attach the user's current text selection. There is no cross-platform API to read another app's
 * selection, so this uses the documented copy convention: the user copies (⌘/Ctrl+C) and Lumen
 * reads the clipboard only at that moment, at the user's request.
 */
async function askAboutSelection() {
  const text = (await clipboard.readText()).slice(0, 200_000);
  if (!text.trim()) {
    windows.showOverlay();
    toast("info", "Copy the text you want to ask about (⌘/Ctrl+C), then press the shortcut again.");
    return;
  }
  core.addText("selected_text", `Selection — ${text.replace(/\s+/g, " ").slice(0, 40)}`, text);
  windows.showOverlay();
}

// ---------------- tray ----------------
function updateTray() {
  if (!tray) return;
  const live = core.live;
  const recording = !!live && ["recording", "reconnecting", "connecting", "paused"].includes(live.status);
  const screenLive = core.liveScreenState.active;
  tray.setToolTip(recording ? "Lumen — recording transcript" : screenLive ? "Lumen — live screen context on" : "Lumen");
  if (process.platform === "darwin") tray.setTitle(recording ? (live!.status === "paused" ? " ❚❚ REC" : " ● REC") : screenLive ? " ▣ LIVE" : "");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide assistant", accelerator: core.settings.shortcuts.toggleOverlay, click: () => windows.toggleOverlay() },
      { label: "Open Lumen", click: () => windows.openMain() },
      { type: "separator" },
      recording
        ? { label: "Stop recording", click: () => core.stopTranscript() }
        : { label: "Live transcript…", click: () => windows.openMain("/main/transcript") },
      ...(screenLive ? [{ label: "Stop live screen context", click: () => core.stopLiveScreen() }] : []),
      { label: "Clear session context", click: () => core.engine.clear(core.activeSessionId) },
      { type: "separator" },
      { label: "Settings", click: () => windows.openMain("/main/settings") },
      { label: "Quit Lumen", role: "quit" },
    ]),
  );
}

function createTray() {
  const iconPath = path.join(__dirname, "../../build/trayTemplate.png");
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on("click", () => windows.toggleOverlay());
  updateTray();
}

// ---------------- IPC ----------------
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Only our own bundled renderer may call privileged APIs.
    const url = event.senderFrame?.url ?? "";
    if (!isTrustedUrl(url)) throw new Error("Untrusted sender");
    try {
      return await fn(event, ...args);
    } catch (err) {
      const message = err instanceof z.ZodError ? "Invalid request." : err instanceof Error ? err.message : "Unexpected error";
      logger.warn("ipc error", { channel, message });
      // Only the sanitized message crosses to the renderer; the original is logged above.
      throw new Error(message, { cause: err });
    }
  });
}

const str = (max: number) => z.string().max(max);
const id = z.string().min(1).max(100);
const secretName = z.enum(["anthropic", "deepgram", "openai_compat"]);

function winOf(e: IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(e.sender) ?? windows.main ?? windows.overlay!;
}

/** Reject access to records that belong to a session other than the active one. */
function assertConversationInActive(convId: string) {
  const c = store.getConversation(convId);
  if (!c) throw new Error("Conversation not found.");
  if (c.sessionId !== core.activeSessionId) throw new Error("That conversation belongs to another session.");
  return c;
}
function assertTranscriptInActive(tid: string) {
  if (tid.startsWith("mem-")) {
    if (core.live?.id !== tid) throw new Error("This in-memory transcript has been discarded.");
    return;
  }
  const t = store.getTranscriptSession(tid);
  if (!t) throw new Error("Transcript not found.");
  if (t.sessionId !== core.activeSessionId) throw new Error("That transcript belongs to another session.");
}

function registerIpc() {
  // ---- settings ----
  handle("settings:get", () => core.settings);
  handle("settings:update", (_e, patch) => {
    const prev = core.settings;
    const next = core.updateSettings(patch);
    if (JSON.stringify(prev.shortcuts) !== JSON.stringify(next.shortcuts)) registerShortcuts();
    if (prev.overlay.position !== next.overlay.position) windows.applyPosition(next);
    if (prev.consent.screen && !next.consent.screen) capture.clearAll();
    updateTray();
    return next;
  });
  handle("settings:resetShortcuts", () => {
    const s = core.resetShortcuts();
    registerShortcuts();
    return s;
  });
  handle("settings:shortcutStatus", () => shortcutStatus);

  // ---- secrets & providers ----
  const secretsStatus = () => ({
    anthropic: secrets.has("anthropic"),
    deepgram: secrets.has("deepgram"),
    openai_compat: secrets.has("openai_compat"),
    encryptionAvailable: secrets.encryptionAvailable,
  });
  handle("secrets:status", secretsStatus);
  handle("secrets:set", (_e, name, value) => {
    secrets.set(secretName.parse(name), str(512).parse(value));
    core.updateSettings({}); // refresh provider health
    return secretsStatus();
  });
  handle("secrets:clear", (_e, name) => {
    secrets.clear(secretName.parse(name));
    core.updateSettings({});
    return secretsStatus();
  });
  handle("provider:test", () => core.testProvider());
  handle("provider:health", () => core.health);

  // ---- sessions ----
  const sessionInput = z.object({
    title: str(120),
    type: modeEnum,
    notes: str(50_000).optional(),
    contextTtlMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
    ai: z.object({ model: z.string().regex(/^[a-z0-9.-]{3,64}$/).optional(), effort: effortEnum.optional(), style: styleEnum.optional() }).optional(),
  });
  handle("sessions:list", () => store.listSessions());
  handle("sessions:active", () => core.ensureActiveSession());
  handle("sessions:create", (_e, input) => core.createSession(sessionInput.parse(input)));
  handle("sessions:update", (_e, sid, patch) => core.updateSession(id.parse(sid), sessionInput.partial().parse(patch)));
  handle("sessions:switch", (_e, sid) => core.switchSession(id.parse(sid)));
  handle("sessions:delete", (_e, sid) => core.deleteSession(id.parse(sid)));
  handle("sessions:export", async (e, sid) => {
    const data = store.exportSession(id.parse(sid));
    if (!data) throw new Error("Session not found.");
    const res = await dialog.showSaveDialog(winOf(e), {
      defaultPath: `lumen-session-${data.session.title.replace(/[^\w-]+/g, "-").slice(0, 40)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return res.filePath;
  });

  // ---- chat ----
  const chatReq = z.object({
    requestId: id,
    sessionId: id.optional(),
    conversationId: id.nullable(),
    text: str(20_000),
    style: styleEnum,
    tone: toneEnum,
    includeLiveTranscript: z.boolean(),
    retryOfMessageId: id.optional(),
  });
  handle("chat:send", (_e, req) => {
    const r = chatReq.parse(req);
    // Requests are always bound to the active session; a stale renderer cannot target another one.
    void core.send({ ...r, sessionId: core.activeSessionId });
  });
  handle("chat:cancel", (_e, rid) => core.chat.cancel(id.parse(rid)));
  handle("history:list", () => store.listConversations(core.activeSessionId));
  handle("history:messages", (_e, cid) => {
    assertConversationInActive(id.parse(cid));
    return store.listMessages(String(cid));
  });
  handle("history:rename", (_e, cid, title) => {
    assertConversationInActive(id.parse(cid));
    store.renameConversation(String(cid), str(200).parse(title));
  });
  handle("history:delete", (_e, cid) => {
    assertConversationInActive(id.parse(cid));
    store.deleteConversation(String(cid));
    emitApp({ type: "history-changed" });
  });
  handle("history:search", (_e, q, scope) => store.search(str(500).parse(q), z.enum(["session", "all"]).parse(scope) === "all" ? null : core.activeSessionId));

  // ---- context ----
  const summaries = () => core.engine.summaries(core.activeSessionId);
  handle("context:list", summaries);
  handle("context:addNote", (_e, title, text) => {
    core.addText("note", str(200).parse(title) || "Note", str(200_000).parse(text), { pinned: true });
    return summaries();
  });
  handle("context:addClipboard", async () => {
    const text = (await clipboard.readText()).slice(0, 200_000);
    if (!text.trim()) throw new Error("The clipboard has no text.");
    core.addText("clipboard", `Clipboard — ${text.replace(/\s+/g, " ").slice(0, 40)}`, text);
    return summaries();
  });
  handle("context:addSelection", async () => {
    await askAboutSelection();
    return summaries();
  });
  handle("context:addDocuments", async (e) => {
    const res = await dialog.showOpenDialog(winOf(e), { properties: ["openFile", "multiSelections"], filters: [{ name: "Documents", extensions: SUPPORTED_DOC_EXTENSIONS }] });
    const failed: { file: string; reason: string }[] = [];
    for (const file of res.filePaths.slice(0, 10)) {
      try {
        core.addText("document", path.basename(file), await extractDocumentText(file), { sourceId: file });
      } catch (err) {
        failed.push({ file: path.basename(file), reason: (err as Error).message });
      }
    }
    return { items: summaries(), failed };
  });
  const ownItem = (cid: string) => {
    const r = core.engine.get(cid);
    if (!r || r.sessionId !== core.activeSessionId) throw new Error("Context item not found.");
    return r;
  };
  handle("context:update", (_e, cid, patch) => {
    ownItem(id.parse(cid));
    core.engine.update(String(cid), z.object({ enabled: z.boolean().optional(), pinned: z.boolean().optional() }).parse(patch));
    return summaries();
  });
  handle("context:confirm", (_e, cid) => {
    ownItem(id.parse(cid));
    core.engine.confirm(String(cid));
    return summaries();
  });
  handle("context:remove", (_e, cid) => {
    ownItem(id.parse(cid));
    core.engine.remove(String(cid));
    return summaries();
  });
  handle("context:clear", (_e, which) => {
    const w = which ? z.enum(["screen", "notes", "documents"]).parse(which) : undefined;
    const sources = w === "screen" ? (["screenshot", "ocr"] as const) : w === "notes" ? (["note", "clipboard", "selected_text"] as const) : w === "documents" ? (["document"] as const) : undefined;
    core.engine.clear(core.activeSessionId, sources ? [...sources] : undefined);
    if (!w || w === "screen") {
      capture.clearAll();
      if (core.liveScreenState.active) core.stopLiveScreen();
    }
    return summaries();
  });

  // ---- capture ----
  const requireScreen = () => {
    if (!core.settings.consent.screen) throw new Error("Screen context is off. Enable it in Permissions.");
  };
  handle("capture:capabilities", () => capture.capabilities());
  handle("capture:sources", () => {
    requireScreen();
    return capture.listSources();
  });
  handle("capture:source", async (_e, sid) => {
    requireScreen();
    const isScreen = String(sid).startsWith("screen:");
    if (isScreen) windows.hideOverlay();
    try {
      return await capture.capture(str(200).parse(sid));
    } finally {
      if (isScreen) windows.overlay?.showInactive();
    }
  });
  handle("capture:importImage", async (e) => {
    requireScreen();
    const res = await dialog.showOpenDialog(winOf(e), { properties: ["openFile"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (!res.filePaths[0]) return null;
    return capture.importImage(res.filePaths[0]);
  });
  handle("capture:attach", (_e, cid, region, title) => {
    requireScreen();
    const r = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().parse(region);
    const f = capture.finalize(id.parse(cid), r);
    // The user already reviewed this capture in the picker, so it is attached as confirmed.
    core.addCapture(
      { title: str(120).parse(title) || `${r ? "Region of " : ""}${f.title}`, sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl },
      { pending: false },
    );
    return summaries();
  });
  handle("capture:discard", (_e, cid) => capture.discard(id.parse(cid)));
  handle("capture:quick", async () => {
    requireScreen();
    await captureAndAttach(null);
    return summaries();
  });
  handle("capture:live", (_e, action) => {
    const a = z.enum(["start", "pause", "resume", "stop"]).parse(action);
    if (a === "start") {
      requireScreen();
      core.startLiveScreen();
    } else if (a === "pause") core.liveScreen.pause();
    else if (a === "resume") core.liveScreen.resume();
    else core.stopLiveScreen();
    updateTray();
    return core.liveScreenState;
  });
  handle("capture:liveState", () => core.liveScreenState);

  // ---- knowledge ----
  const scopeEnum = z.enum(["global", "session"]);
  handle("kb:list", () => store.listKnowledgeDocs(core.activeSessionId));
  handle("kb:import", async (e, kind, scope) => {
    const k = z.enum(["files", "folder"]).parse(kind);
    const res = await dialog.showOpenDialog(winOf(e), {
      properties: k === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
      filters: k === "folder" ? undefined : [{ name: "Documents", extensions: SUPPORTED_DOC_EXTENSIONS }],
    });
    if (!res.filePaths.length) return { imported: [], failed: [], skipped: 0, docs: store.listKnowledgeDocs(core.activeSessionId) };
    const result = await core.importKnowledge(res.filePaths, scopeEnum.parse(scope));
    logger.info("knowledge import", { imported: result.imported.length, failed: result.failed.length, skipped: result.skipped });
    return { ...result, docs: store.listKnowledgeDocs(core.activeSessionId) };
  });
  handle("kb:addText", (_e, title, text, scope) => {
    core.addKnowledgeText(str(200).parse(title), str(500_000).parse(text), scopeEnum.parse(scope));
    return store.listKnowledgeDocs(core.activeSessionId);
  });
  handle("kb:delete", (_e, did) => {
    const doc = store.listKnowledgeDocs(core.activeSessionId).find((d) => d.id === id.parse(did));
    if (!doc) throw new Error("Document not found.");
    store.deleteKnowledgeDoc(doc.id);
    return store.listKnowledgeDocs(core.activeSessionId);
  });
  handle("kb:search", (_e, q) => store.searchKnowledge(str(500).parse(q), core.activeSessionId, 20));

  // ---- transcription ----
  handle("transcript:start", (_e, title) => {
    core.startTranscript(str(200).parse(title));
    updateTray();
  });
  handle("transcript:pause", () => {
    core.pauseTranscript();
    updateTray();
  });
  handle("transcript:resume", () => {
    core.resumeTranscript();
    updateTray();
  });
  handle("transcript:stop", () => {
    core.stopTranscript();
    updateTray();
  });
  handle("transcript:state", () => {
    const l = core.live;
    const visible = l && l.workspaceSessionId === core.activeSessionId;
    return {
      sessionId: visible ? l.id : null,
      workspaceSessionId: l?.workspaceSessionId ?? null,
      status: visible ? l.status : l && ["recording", "paused", "reconnecting", "connecting"].includes(l.status) ? l.status : "idle",
      title: l?.title ?? null,
      persisted: l?.persisted ?? true,
      channels: l?.channels ?? 1,
      segments: visible ? l.liveSegments() : [],
    };
  });
  handle("transcript:list", () => {
    const list = store.listTranscriptSessions(core.activeSessionId);
    const l = core.live;
    if (l && !l.persisted && l.workspaceSessionId === core.activeSessionId && l.status !== "stopped" && l.status !== "error") {
      list.unshift({ id: l.id, sessionId: l.workspaceSessionId, title: `${l.title} (not saved)`, startedAt: l.started, endedAt: null, segmentCount: l.liveSegments().length, provider: "deepgram", persisted: false });
    }
    return list;
  });
  handle("transcript:segments", (_e, tid) => {
    assertTranscriptInActive(id.parse(tid));
    return core.liveSegments(String(tid)) ?? store.listSegments(String(tid));
  });
  handle("transcript:updateSegment", (_e, segId, text, speaker) => store.updateSegment(id.parse(segId), str(10_000).parse(text), str(60).nullable().parse(speaker)));
  handle("transcript:deleteSegment", (_e, segId) => store.deleteSegment(id.parse(segId)));
  handle("transcript:rename", (_e, tid, title) => {
    assertTranscriptInActive(id.parse(tid));
    store.renameTranscriptSession(String(tid), str(200).parse(title));
  });
  handle("transcript:delete", (_e, tid) => {
    const t = id.parse(tid);
    assertTranscriptInActive(t);
    if (core.live?.id === t) core.stopTranscript();
    store.deleteTranscriptSession(t);
    emitApp({ type: "history-changed" });
  });
  handle("transcript:insights", (_e, tid) => {
    assertTranscriptInActive(id.parse(tid));
    return core.generateInsights(String(tid), new AbortController().signal);
  });
  handle("transcript:getInsights", (_e, tid) => {
    assertTranscriptInActive(id.parse(tid));
    return store.getInsights(String(tid));
  });

  // Audio frames arrive at ~10 Hz; validate size and only accept from our renderer.
  ipcMain.on("transcript:audio", (event, pcm: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? "")) return;
    if (!(pcm instanceof Uint8Array) || pcm.byteLength > 128_000) return;
    core.pushAudio(pcm);
  });
  const audioStateSchema = z.object({
    micLabel: str(200).nullable(),
    systemAudio: z.enum(["off", "active", "unavailable", "denied"]),
    micLevel: z.number().min(0).max(1),
    systemLevel: z.number().min(0).max(1),
    silentForMs: z.number().min(0),
  });
  ipcMain.on("transcript:audioState", (event, state: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? "")) return;
    const parsed = audioStateSchema.safeParse(state);
    if (!parsed.success) return;
    audioState = parsed.data;
    windows.broadcast("lumen:transcript", { type: "audio", state: parsed.data });
  });
  ipcMain.on("transcript:captureFailed", (event, message: unknown, kind: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? "")) return;
    const msg = String(message).slice(0, 300);
    logger.warn("audio capture failed", { message: msg, kind: String(kind) });
    if (kind === "system") {
      toast("error", `System audio unavailable: ${msg}. Continuing with the microphone only.`);
      return;
    }
    if (core.live) core.live.stop();
    toast("error", `Microphone capture failed: ${msg}`);
    updateTray();
  });

  // ---- permissions ----
  handle("permissions:get", () => permissionStatus());
  handle("permissions:requestMic", () => requestMicrophone());
  handle("permissions:open", async (_e, kind) => {
    const url = permissionSettingsUrl(z.enum(["screen", "microphone"]).parse(kind));
    if (url) await shell.openExternal(url);
  });

  // ---- data ----
  handle("data:export", async (e) => {
    const res = await dialog.showSaveDialog(winOf(e), { defaultPath: `lumen-export-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(store.exportAll(), null, 2), { mode: 0o600 });
    return res.filePath;
  });
  handle("data:deleteAll", () => {
    capture.clearAll();
    core.deleteAll();
    updateTray();
    logger.info("all user data deleted");
  });
  handle("diagnostics:get", () => diagnostics());
  handle("diagnostics:openLogs", async () => {
    await shell.openPath(path.dirname(logger.file));
  });

  // ---- window / misc ----
  handle("app:copy", (_e, text) => clipboard.writeText(str(500_000).parse(text)));
  handle("app:openExternal", async (_e, url) => {
    const u = str(2000).parse(url);
    if (/^https:\/\//.test(u)) await shell.openExternal(u);
  });
  handle("overlay:action", (_e, action) => {
    const a = z.enum(["hide", "toggle", "expand", "compact", "reset-position"]).parse(action);
    if (a === "hide") windows.hideOverlay();
    else if (a === "toggle") windows.toggleOverlay();
    else if (a === "expand") windows.setMode("expanded");
    else if (a === "compact") windows.setMode("compact");
    else windows.resetPosition();
  });
  handle("overlay:setSize", (_e, w, h) => windows.setOverlaySize(z.number().parse(w), z.number().parse(h)));
  handle("app:openMain", (_e, route) => {
    windows.openMain(route ? z.string().regex(/^\/main\/[a-z-]+$/).parse(route) : undefined);
  });
}

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
function diagnostics(): Diagnostics {
  const cpu = process.cpuUsage(lastCpu);
  const elapsed = (Date.now() - lastCpuAt) * 1000;
  lastCpu = process.cpuUsage();
  lastCpuAt = Date.now();
  const allMem = app.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024;
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userDataPath: userData,
    dbPath: store.path,
    logPath: logger.file,
    logLevel: core.settings.diagnostics.logLevel,
    provider: core.health,
    transcription: { kind: core.settings.transcription.kind, configured: secrets.has("deepgram") },
    permissions: permissionStatus(),
    capture: capture.capabilities(),
    shortcutsRegistered: { ...shortcutStatus },
    metrics: core.metrics.snapshot(),
    process: { memoryMb: Math.round(allMem), cpuPercent: elapsed > 0 ? Math.round(((cpu.user + cpu.system) / elapsed) * 1000) / 10 : 0 },
    storage: store.counts(),
  };
}

function applyCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; frame-src 'none'",
        ],
      },
    });
  });
  // Only grant media permissions to our own renderer, and only for what the user enabled.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const trusted = isTrustedUrl(details.requestingUrl ?? wc.getURL());
    if (!trusted) return cb(false);
    if (permission === "media") {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      // Microphone needs microphone consent; display capture (system-audio loopback) needs system-audio consent.
      if (types.includes("video")) return cb(core.settings.consent.systemAudio);
      return cb(core.settings.consent.microphone);
    }
    if (permission === "clipboard-sanitized-write") return cb(true);
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!isTrustedUrl(origin + "/dist-renderer/index.html") && !isTrustedUrl(origin)) return false;
    if (permission === "media") return core.settings.consent.microphone;
    return permission === "clipboard-sanitized-write";
  });
  // System audio loopback for the transcript, gated on explicit consent.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    if (!core.settings.consent.systemAudio) return cb({});
    const { desktopCapturer } = await import("electron");
    const [screenSource] = await desktopCapturer.getSources({ types: ["screen"] });
    if (!screenSource) return cb({});
    cb({ video: screenSource, audio: "loopback" });
  });
}

app.on("second-instance", () => windows?.showOverlay());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  core?.stopTranscript();
  core?.stopLiveScreen();
  void ocr.dispose();
  store?.close();
});
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
app.on("activate", () => windows.openMain());

process.on("uncaughtException", (err) => logger.error("uncaught exception", { message: err.message, stack: err.stack }));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { message: String(err) }));

const ocr = new TesseractOcr({ timeoutMs: 30_000 });

void app.whenReady().then(() => {
  store = new Store(path.join(userData, "lumen.db"));
  const raw = store.getKv("settings");
  const settings = loadSettings(raw ? JSON.parse(raw) : null);
  logger.level = settings.diagnostics.logLevel;

  core = new AppCore(
    {
      store,
      secrets,
      ocr,
      emitChat: (e) => windows?.broadcast("lumen:chat", e),
      emitTranscript: (e) => {
        windows?.broadcast("lumen:transcript", e);
        if (e.type === "status") updateTray();
      },
      emitApp: (e) => {
        emitApp(e);
        if (e.type === "live-screen") updateTray();
      },
      log: (level, msg, data) => logger.log(level, msg, data),
      liveScreenCapture: async () => {
        // Live sampling captures the display under the cursor. The overlay is a normal window, so
        // it may appear in the frame; that is visible to the user and harmless.
        const held = await capture.captureCursorDisplay();
        const f = capture.finalize(held.captureId, null);
        return { title: f.title, sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl };
      },
    },
    settings,
    (s) => store.setKv("settings", JSON.stringify(s)),
  );
  store.setKv("settings", JSON.stringify(core.settings));
  const purged = core.sweep();
  logger.info("app ready", { version: app.getVersion(), platform: process.platform, purged, schema: store.schemaVersion() });
  setInterval(() => core.sweep(), 60_000).unref();

  windows = new WindowManager(
    () => core.settings,
    (bounds, patch) => core.updateSettings({ overlay: { bounds, ...patch } }),
    (mode) => emitApp({ type: "overlay-mode", mode }),
  );
  applyCsp();
  registerIpc();
  registerShortcuts();
  createTray();
  if (process.platform === "darwin") app.dock?.hide();
  windows.createOverlay();
  if (!core.settings.onboardingComplete) windows.openMain("/main/onboarding");
  else windows.showOverlay();

  if (process.env.LUMEN_SMOKE_TEST) void import("./smoke.js").then((m) => m.runSmokeTest({ app, core, store, windows, capture, shortcutStatus }));
});
