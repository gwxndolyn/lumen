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
import { ChatService } from "../src/core/chatService";
import { ContextStore } from "../src/core/context/contextStore";
import { chunkText, normalizeText } from "../src/core/context/text";
import { generateInsights } from "../src/core/meetingService";
import { Metrics } from "../src/core/metrics";
import { AnthropicProvider } from "../src/core/providers/anthropic";
import { MockProvider } from "../src/core/providers/mock";
import { ProviderError, type AIProvider } from "../src/core/providers/types";
import { Store } from "../src/core/storage/db";
import { DeepgramProvider } from "../src/core/transcription/deepgram";
import { TranscriptSession } from "../src/core/transcription/session";
import { DEFAULT_SHORTCUTS } from "../src/shared/defaults";
import { applySettingsPatch, loadSettings } from "../src/shared/settingsSchema";
import type { ChatEvent, Diagnostics, Settings, TranscriptEvent } from "../src/shared/types";
import { CaptureService, permissionSettingsUrl, permissionStatus, requestMicrophone } from "./capture";
import { extractDocumentText, SUPPORTED_DOC_EXTENSIONS } from "./documents";
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
let store: Store;
let settings: Settings;
let windows: WindowManager;
let tray: Tray | null = null;
const secrets = new SecretStore(userData, safeStorage);
const context = new ContextStore();
const metrics = new Metrics();
const capture = new CaptureService();
let liveSession: TranscriptSession | null = null;
const shortcutStatus: Record<string, boolean> = {};

function persistSettings() {
  store.setKv("settings", JSON.stringify(settings));
}

function getProvider(): AIProvider | null {
  if (settings.provider.kind === "mock") return new MockProvider();
  const key = secrets.get("anthropic");
  return key ? new AnthropicProvider({ apiKey: key }) : null;
}

function emitChat(e: ChatEvent) {
  windows.broadcast("lumen:chat", e);
  if (e.type === "done" || e.type === "cancelled") windows.broadcast("lumen:app", { type: "history-changed" });
}
function emitTranscript(e: TranscriptEvent) {
  windows.broadcast("lumen:transcript", e);
  updateTray();
}
function emitApp(e: unknown) {
  windows.broadcast("lumen:app", e);
}

let chat: ChatService;

context.onChange(() => emitApp({ type: "context", items: context.summaries() }));

// ---------------- shortcuts ----------------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const map: [keyof Settings["shortcuts"], () => void][] = [
    ["toggleOverlay", () => windows.toggleOverlay()],
    ["askAboutScreen", () => void askAboutScreen()],
    ["openMainWindow", () => windows.openMain()],
  ];
  for (const [name, fn] of map) {
    const acc = settings.shortcuts[name];
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

async function askAboutScreen() {
  if (!settings.consent.screen) {
    windows.openMain("/main/permissions");
    emitApp({ type: "toast", level: "info", message: "Enable screen context in Permissions first." });
    return;
  }
  try {
    const wasVisible = windows.overlay?.isVisible();
    windows.hideOverlay(); // never capture our own panel
    await new Promise((r) => setTimeout(r, 120));
    const id = await capture.captureCursorDisplay();
    const img = capture.finalize(id, null);
    context.add({ kind: "screenshot", title: `Screen — ${img.title}`, text: "", image: { mediaType: img.mediaType, data: img.data } });
    windows.showOverlay();
    if (!wasVisible) logger.info("screen captured via shortcut");
  } catch (err) {
    windows.showOverlay();
    emitApp({ type: "toast", level: "error", message: (err as Error).message });
  }
}

// ---------------- tray ----------------
function updateTray() {
  if (!tray) return;
  const recording = liveSession && (liveSession.status === "recording" || liveSession.status === "reconnecting");
  tray.setToolTip(recording ? "Lumen — recording transcript" : "Lumen");
  if (process.platform === "darwin") tray.setTitle(recording ? " ● REC" : "");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide assistant", accelerator: settings.shortcuts.toggleOverlay, click: () => windows.toggleOverlay() },
      { label: "Open Lumen", click: () => windows.openMain() },
      { type: "separator" },
      recording
        ? { label: "Stop recording", click: () => stopTranscript() }
        : { label: "Live transcript…", click: () => windows.openMain("/main/transcript") },
      { label: "Clear session context", click: () => context.clear() },
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

// ---------------- transcript ----------------
function startTranscript(title: string) {
  if (liveSession && liveSession.status !== "stopped" && liveSession.status !== "error") return;
  if (!settings.consent.microphone) throw new ProviderError("Enable microphone access for Lumen in Permissions first.", "bad_request", false);
  if (settings.transcription.kind === "none") throw new ProviderError("Choose a transcription provider in Settings first.", "bad_request", false);
  const key = secrets.get("deepgram");
  if (!key) throw new ProviderError("Add a Deepgram API key in Settings → Transcription to record a live transcript.", "missing_credentials", false);
  liveSession = new TranscriptSession(
    new DeepgramProvider(key),
    store,
    emitTranscript,
    { language: settings.transcription.language, diarize: true, title: title.trim().slice(0, 120) || `Meeting ${new Date().toLocaleString()}` },
    (ms) => metrics.recordTranscriptionLatency(ms),
  );
  emitApp({
    type: "audio-command",
    command: "start",
    micDeviceId: settings.transcription.microphoneDeviceId,
    systemAudio: settings.transcription.captureSystemAudio && settings.consent.systemAudio,
  });
  logger.info("transcript started", { sessionId: liveSession.id });
}

function stopTranscript() {
  emitApp({ type: "audio-command", command: "stop", micDeviceId: null, systemAudio: false });
  if (liveSession) {
    liveSession.stop();
    logger.info("transcript stopped", { sessionId: liveSession.id });
  }
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
      const message = err instanceof Error ? err.message : "Unexpected error";
      logger.warn("ipc error", { channel, message });
      throw new Error(message);
    }
  });
}

const str = (max: number) => z.string().max(max);
const id = z.string().min(1).max(100);

async function readClipboardText(): Promise<string> {
  return (await clipboard.readText()).slice(0, 200_000);
}

function registerIpc() {
  handle("settings:get", () => settings);
  handle("settings:update", (_e, patch) => {
    const prev = settings;
    settings = applySettingsPatch(settings, patch);
    persistSettings();
    if (JSON.stringify(prev.shortcuts) !== JSON.stringify(settings.shortcuts)) registerShortcuts();
    windows.applyOverlaySettings();
    if (!settings.consent.microphone && liveSession) stopTranscript();
    if (!settings.consent.screen) context.clear("screenshot");
    emitApp({ type: "settings", settings });
    updateTray();
    return settings;
  });
  handle("settings:resetShortcuts", () => {
    settings = applySettingsPatch(settings, { shortcuts: DEFAULT_SHORTCUTS });
    persistSettings();
    registerShortcuts();
    emitApp({ type: "settings", settings });
    return settings;
  });
  handle("settings:shortcutStatus", () => shortcutStatus);

  const secretsStatus = () => ({
    anthropic: secrets.has("anthropic"),
    deepgram: secrets.has("deepgram"),
    encryptionAvailable: secrets.encryptionAvailable,
  });
  const secretName = z.enum(["anthropic", "deepgram"]);
  handle("secrets:status", secretsStatus);
  handle("secrets:set", (_e, name, value) => {
    secrets.set(secretName.parse(name), str(512).parse(value));
    return secretsStatus();
  });
  handle("secrets:clear", (_e, name) => {
    secrets.clear(secretName.parse(name));
    return secretsStatus();
  });
  handle("provider:test", async () => {
    const p = getProvider();
    if (!p) return { ok: false, message: "No Anthropic API key is configured.", latencyMs: null };
    return p.test(settings.provider.model);
  });

  const chatReq = z.object({
    requestId: id,
    conversationId: id.nullable(),
    text: str(20_000),
    mode: z.enum(["general", "meeting", "interview", "technical", "coding"]),
    length: z.enum(["short", "detailed"]),
    tone: z.enum(["neutral", "friendly", "formal", "confident"]),
    includeLiveTranscript: z.boolean(),
    retryOfMessageId: id.optional(),
  });
  handle("chat:send", (_e, req) => {
    void chat.send(chatReq.parse(req));
  });
  handle("chat:cancel", (_e, rid) => chat.cancel(id.parse(rid)));
  handle("history:list", () => store.listConversations());
  handle("history:messages", (_e, cid) => store.listMessages(id.parse(cid)));
  handle("history:rename", (_e, cid, title) => store.renameConversation(id.parse(cid), str(200).parse(title)));
  handle("history:delete", (_e, cid) => {
    store.deleteConversation(id.parse(cid));
  });
  handle("history:search", (_e, q) => store.search(str(500).parse(q)));

  handle("context:list", () => context.summaries());
  handle("context:addNote", (_e, title, text) => {
    context.add({ kind: "note", title: str(200).parse(title) || "Note", text: str(200_000).parse(text), pinned: true });
    return context.summaries();
  });
  handle("context:addClipboard", async () => {
    const text = await readClipboardText();
    if (!text.trim()) throw new Error("The clipboard has no text.");
    context.add({ kind: "clipboard", title: `Clipboard — ${normalizeText(text).slice(0, 40)}`, text });
    return context.summaries();
  });
  handle("context:addDocuments", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Documents", extensions: SUPPORTED_DOC_EXTENSIONS }],
    });
    for (const file of res.filePaths.slice(0, 10)) {
      const text = await extractDocumentText(file);
      context.add({ kind: "document", title: path.basename(file), text });
    }
    return context.summaries();
  });
  handle("context:update", (_e, cid, patch) => {
    context.update(id.parse(cid), z.object({ enabled: z.boolean().optional(), pinned: z.boolean().optional() }).parse(patch));
    return context.summaries();
  });
  handle("context:remove", (_e, cid) => {
    context.remove(id.parse(cid));
    return context.summaries();
  });
  handle("context:clear", (_e, kind) => {
    context.clear(kind ? z.enum(["note", "clipboard", "document", "screenshot"]).parse(kind) : undefined);
    if (!kind) capture.clearAll();
    return context.summaries();
  });

  const requireScreen = () => {
    if (!settings.consent.screen) throw new Error("Screen context is off. Enable it in Permissions.");
  };
  handle("capture:sources", async () => {
    requireScreen();
    return capture.listSources();
  });
  handle("capture:source", async (_e, sid) => {
    requireScreen();
    return capture.capture(str(200).parse(sid));
  });
  handle("capture:attach", (_e, cid, region, title) => {
    requireScreen();
    const r = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().parse(region);
    const img = capture.finalize(id.parse(cid), r);
    context.add({
      kind: "screenshot",
      title: str(120).parse(title) || `${r ? "Region of " : ""}${img.title}`,
      text: "",
      image: { mediaType: img.mediaType, data: img.data },
    });
    return context.summaries();
  });
  handle("capture:discard", (_e, cid) => capture.discard(id.parse(cid)));
  handle("capture:quick", async () => {
    requireScreen();
    await askAboutScreen();
    return context.summaries();
  });

  handle("kb:list", () => store.listKnowledgeDocs());
  handle("kb:import", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Documents", extensions: SUPPORTED_DOC_EXTENSIONS }],
    });
    for (const file of res.filePaths.slice(0, 20)) {
      const text = normalizeText(await extractDocumentText(file));
      if (text) store.addKnowledgeDoc(path.basename(file), file, chunkText(text));
    }
    return store.listKnowledgeDocs();
  });
  handle("kb:addText", (_e, title, text) => {
    const t = normalizeText(str(500_000).parse(text));
    if (!t) throw new Error("The note is empty.");
    store.addKnowledgeDoc(str(200).parse(title) || "Untitled note", "manual", chunkText(t));
    return store.listKnowledgeDocs();
  });
  handle("kb:delete", (_e, did) => {
    store.deleteKnowledgeDoc(id.parse(did));
    return store.listKnowledgeDocs();
  });

  handle("transcript:start", (_e, title) => startTranscript(str(200).parse(title)));
  handle("transcript:pause", () => liveSession?.pause());
  handle("transcript:resume", () => liveSession?.resume());
  handle("transcript:stop", () => stopTranscript());
  handle("transcript:state", () => ({
    sessionId: liveSession?.id ?? null,
    status: liveSession?.status ?? "idle",
    title: liveSession?.title ?? null,
  }));
  handle("transcript:list", () => store.listTranscriptSessions());
  handle("transcript:segments", (_e, sid) => store.listSegments(id.parse(sid)));
  handle("transcript:updateSegment", (_e, segId, text, speaker) =>
    store.updateSegment(id.parse(segId), str(10_000).parse(text), str(60).nullable().parse(speaker)),
  );
  handle("transcript:deleteSegment", (_e, segId) => store.deleteSegment(id.parse(segId)));
  handle("transcript:rename", (_e, sid, title) => store.renameTranscriptSession(id.parse(sid), str(200).parse(title)));
  handle("transcript:delete", (_e, sid) => {
    const s = id.parse(sid);
    if (liveSession?.id === s) stopTranscript();
    store.deleteTranscriptSession(s);
  });
  handle("transcript:insights", async (_e, sid) => {
    const p = getProvider();
    if (!p) throw new Error("No Anthropic API key is configured.");
    return generateInsights(p, store, settings, id.parse(sid), new AbortController().signal);
  });
  handle("transcript:getInsights", (_e, sid) => store.getInsights(id.parse(sid)));

  // Audio frames arrive at ~10 Hz; validate size and only accept from our renderer.
  ipcMain.on("transcript:audio", (event, pcm: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? "")) return;
    if (!(pcm instanceof Uint8Array) || pcm.byteLength > 64_000) return;
    liveSession?.pushAudio(pcm);
  });
  ipcMain.on("transcript:captureFailed", (event, message: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? "")) return;
    logger.warn("audio capture failed", { message: String(message).slice(0, 300) });
    if (liveSession) liveSession.stop();
    emitApp({ type: "toast", level: "error", message: `Audio capture failed: ${String(message).slice(0, 200)}` });
  });

  handle("permissions:get", () => permissionStatus());
  handle("permissions:requestMic", () => requestMicrophone());
  handle("permissions:open", async (_e, kind) => {
    const url = permissionSettingsUrl(z.enum(["screen", "microphone"]).parse(kind));
    if (url) await shell.openExternal(url);
  });

  handle("data:export", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: `lumen-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(store.exportAll(), null, 2), { mode: 0o600 });
    return res.filePath;
  });
  handle("data:deleteAll", () => {
    stopTranscript();
    chat.cancelAll();
    store.deleteAll();
    context.clear();
    capture.clearAll();
    emitApp({ type: "history-changed" });
    logger.info("all user data deleted");
  });
  handle("diagnostics:get", () => diagnostics());
  handle("diagnostics:openLogs", async () => {
    await shell.openPath(path.dirname(logger.file));
  });

  handle("app:copy", (_e, text) => clipboard.writeText(str(500_000).parse(text)));
  handle("app:openExternal", async (_e, url) => {
    const u = str(2000).parse(url);
    if (/^https:\/\//.test(u)) await shell.openExternal(u);
  });
  handle("overlay:action", (_e, action) => {
    const a = z.enum(["hide", "toggle", "expand", "compact"]).parse(action);
    if (a === "hide") windows.hideOverlay();
    else if (a === "toggle") windows.toggleOverlay();
    else if (a === "expand") windows.setOverlaySize(Math.max(windows.overlay?.getBounds().width ?? 560, 640), 640);
    else windows.setOverlaySize(windows.overlay?.getBounds().width ?? 560, 180);
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
    provider: { kind: settings.provider.kind, model: settings.provider.model, configured: settings.provider.kind === "mock" || secrets.has("anthropic") },
    transcription: { kind: settings.transcription.kind, configured: secrets.has("deepgram") },
    permissions: permissionStatus(),
    shortcutsRegistered: { ...shortcutStatus },
    metrics: metrics.snapshot(),
    process: {
      memoryMb: Math.round(allMem),
      cpuPercent: elapsed > 0 ? Math.round(((cpu.user + cpu.system) / elapsed) * 1000) / 10 : 0,
    },
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
    if (permission === "media") return cb(settings.consent.microphone);
    if (permission === "clipboard-sanitized-write") return cb(true);
    cb(false);
  });
  // System audio loopback for the transcript, gated on explicit consent.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    if (!settings.consent.systemAudio) return cb({});
    const { desktopCapturer } = await import("electron");
    const [screenSource] = await desktopCapturer.getSources({ types: ["screen"] });
    if (!screenSource) return cb({});
    cb({ video: screenSource, audio: "loopback" });
  });
}

app.on("second-instance", () => windows?.showOverlay());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  liveSession?.stop();
  store?.close();
});
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
app.on("activate", () => windows.openMain());

process.on("uncaughtException", (err) => logger.error("uncaught exception", { message: err.message, stack: err.stack }));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { message: String(err) }));

void app.whenReady().then(() => {
  store = new Store(path.join(userData, "lumen.db"));
  const raw = store.getKv("settings");
  settings = loadSettings(raw ? JSON.parse(raw) : null);
  persistSettings();
  const purged = store.applyRetention(settings.privacy.conversationRetentionDays, settings.privacy.transcriptRetentionDays);
  logger.info("app ready", { version: app.getVersion(), platform: process.platform, purged });
  setInterval(
    () => store.applyRetention(settings.privacy.conversationRetentionDays, settings.privacy.transcriptRetentionDays),
    60 * 60_000,
  ).unref();
  setInterval(() => context.expire(), 60_000).unref();

  windows = new WindowManager(
    () => settings,
    (bounds) => {
      settings = applySettingsPatch(settings, { overlay: { bounds } });
      persistSettings();
    },
  );
  chat = new ChatService({
    store,
    context,
    metrics,
    getSettings: () => settings,
    getProvider,
    getLiveTranscript: () =>
      liveSession && liveSession.status !== "error" && liveSession.status !== "stopped"
        ? { title: liveSession.title, text: liveSession.recentTranscript(), startedAt: liveSession.started }
        : null,
    emit: emitChat,
    log: (level, msg, data) => logger.log(level, msg, data),
  });
  applyCsp();
  registerIpc();
  registerShortcuts();
  createTray();
  if (process.platform === "darwin") app.dock?.hide();
  windows.createOverlay();
  if (!settings.onboardingComplete) windows.openMain("/main/onboarding");
  else windows.showOverlay();

  if (process.env.LUMEN_SMOKE_TEST) void runSmokeTest();
});

/**
 * Automated smoke/UI test (LUMEN_SMOKE_TEST=1). Boots the real app, verifies renderer isolation,
 * then drives a full chat through the overlay UI using the labelled mock provider, checks it was
 * persisted and searchable, and saves screenshots to LUMEN_SMOKE_SHOTS if set.
 */
async function runSmokeTest() {
  const result: Record<string, unknown> = {};
  const shots = process.env.LUMEN_SMOKE_SHOTS;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win: BrowserWindow, name: string) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    const win = windows.openMain("/main/onboarding");
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
    await wait(600);
    await shot(win, "01-onboarding");
    const js = (code: string) => win.webContents.executeJavaScript(code);
    result.bridge = await js("window.lumen.role");
    result.nodeInRenderer = await js("typeof require + '/' + typeof process");
    result.shortcuts = { ...shortcutStatus };
    result.schemaVersion = store.schemaVersion();
    await js("window.lumen.updateSettings({ provider: { kind: 'mock' }, onboardingComplete: true })");

    // Drive the overlay like a user: type a question and press Enter.
    const ov = windows.overlay!;
    windows.showOverlay();
    await wait(500);
    context.add({ kind: "note", title: "Release plan", text: "Version 2 ships on Friday after QA sign-off." });
    await wait(200);
    const ojs = (code: string) => ov.webContents.executeJavaScript(code);
    await ojs(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'When does version 2 ship?');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    let answered = false;
    for (let i = 0; i < 50 && !answered; i++) {
      await wait(100);
      answered = await ojs("document.body.innerText.includes('Context sources received') && !document.querySelector('.cursor-blink')");
    }
    result.overlayChatAnswered = answered;
    result.mockLabelVisible = await ojs("document.body.innerText.includes('Development mode')");
    result.overlayIdleAfterAnswer = await ojs("!document.body.innerText.includes('Thinking') && document.body.innerText.includes('Ask ↵')");
    await wait(600);
    await shot(ov, "02-overlay-answer");
    result.persisted = store.counts().messages;
    result.searchHits = store.search("version").length;

    // Visit each main screen to make sure none crash on render.
    const routes = ["assistant", "transcript", "history", "knowledge", "capture", "settings", "provider", "shortcuts", "permissions", "privacy", "diagnostics"];
    const broken: string[] = [];
    for (const r of routes) {
      await js(`location.hash = '/main/${r}'`);
      await wait(250);
      const ok = await js("document.querySelector('.page-header h1') !== null");
      if (!ok) broken.push(r);
      if (["history", "transcript", "provider", "diagnostics", "permissions"].includes(r)) await shot(win, `03-${r}`);
    }
    result.brokenScreens = broken;
    const ok =
      result.bridge === "main" &&
      result.nodeInRenderer === "undefined/undefined" &&
      answered &&
      result.mockLabelVisible === true &&
      Number(result.persisted) >= 2 &&
      Number(result.searchHits) >= 1 &&
      broken.length === 0;
    console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${JSON.stringify(result)}`);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(`SMOKE FAIL ${(err as Error).message} ${JSON.stringify(result)}`);
    app.exit(1);
  }
}
