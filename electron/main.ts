import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AppCore } from "../src/core/app";
import { ShortcutManager, type ShortcutAction } from "../src/core/shortcuts";
import { formatFromPath, markdownToText, sessionToMarkdown } from "../src/core/exportFormat";
import { buildSupportBundle } from "../src/core/supportBundle";
import { singleFlight } from "../src/core/singleFlight";
import { EvalService } from "../src/core/eval/service";
import { EvalStore } from "../src/core/eval/store";
import { buildProposals } from "../src/core/quality/proposals";
import { TesseractOcr } from "../src/core/ocr";
import { SUPPORTED_DOC_EXTENSIONS, extractDocumentText } from "../src/core/knowledge";
import type { Store } from "../src/core/storage/db";
import { openStore } from "../src/core/storage/open";
import { cleanupTempFiles, writeFileAtomic } from "../src/core/fsutil";
import { CATEGORY_LABELS } from "../src/core/interview/questions";
import type { AppEvent } from "../src/shared/api";
import { loadSettingsJson, modeEnum, styleEnum, toneEnum, effortEnum } from "../src/shared/settingsSchema";
import type { AudioInputState, Diagnostics } from "../src/shared/types";
import { CaptureService, IMAGE_EXTENSIONS, permissionSettingsUrl, permissionStatus, requestMicrophone } from "./capture";
import { Logger } from "./logger";
import { SecretStore } from "./secrets";
import { isTrustedUrl, WindowManager } from "./windows";
import { currentPlatform, initPlatformIdentity, notify, wantsToggle } from "./platform";

// Isolated profile for automated smoke tests.
if (process.env.LUMEN_USER_DATA) app.setPath("userData", process.env.LUMEN_USER_DATA);

initPlatformIdentity();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath("userData");
const logger = new Logger(path.join(userData, "logs"));
const secrets = new SecretStore(userData, safeStorage, !app.isPackaged);
const capture = new CaptureService();
const shortcutStatus: Record<string, boolean> = {};
let store: Store;
let core: AppCore;
let evals: EvalService;
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
/** Native registrar backed by Electron's globalShortcut (macOS, Windows, X11 Linux). */
const electronRegistrar = {
  register: (acc: string, fn: () => void) => globalShortcut.register(acc, fn),
  unregister: (acc: string) => {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* invalid accelerators were never registered */
    }
  },
};

let shortcuts: ShortcutManager;

function shortcutHandlers(): Record<ShortcutAction, () => void> {
  return {
    requestAssist: () => void requestAssist(),
    // Toggle without stealing focus from the app the user is working in.
    toggleOverlay: () => windows.toggleOverlay({ focus: false }),
    scrollUp: () => emitApp({ type: "scroll", direction: "up" }),
    scrollDown: () => emitApp({ type: "scroll", direction: "down" }),
    moveLeft: () => windows.nudge("left"),
    moveRight: () => windows.nudge("right"),
    discreetInput: () => toggleDiscreet(),
    askAboutScreen: () => void askAboutScreen(),
    askAboutSelection: () => void askAboutSelection(),
    openMainWindow: () => windows.openMain(),
    cancelResponse: () => {
      const n = core.cancelAllAnswers();
      if (n) toast("info", n === 1 ? "Answer stopped." : `${n} answers stopped.`);
    },
    toggleAudio: () => {
      const r = core.toggleTranscriptPause();
      if (r === "none") toast("info", "No live transcript is running.");
      else toast("info", r === "paused" ? "Audio paused — nothing is being sent." : "Audio resumed.");
    },
  };
}

function initShortcuts() {
  shortcuts = new ShortcutManager(electronRegistrar, process.platform, core.settings.shortcuts, shortcutHandlers(), (status) => {
    for (const [k, v] of Object.entries(status)) shortcutStatus[k] = v.status === "active" || v.status === "inactive";
    emitApp({ type: "shortcut-status", status });
    for (const [k, v] of Object.entries(status)) if (v.status === "conflict" || v.status === "invalid") logger.warn("shortcut unavailable", { name: k, accelerator: v.accelerator, status: v.status });
  });
  windows.onVisibilityChange = (visible) => shortcuts.setPanelVisible(visible);
  shortcuts.setPanelVisible(windows.overlayVisible);
  shortcuts.apply();
}

function registerShortcuts() {
  shortcuts?.setBindings(core.settings.shortcuts);
}

/**
 * ⌘/Ctrl+Enter. The panel decides: if a question is typed it is submitted; otherwise it calls
 * `assist:prepare`, which gathers whatever context is authorized (a fresh screen capture when
 * screen context is on, the live transcript when recording) and returns the prompt to send.
 */
async function requestAssist() {
  if (!windows.overlayVisible) windows.showOverlay({ focus: false });
  if (windows.mode === "compact") windows.setMode("expanded");
  emitApp({ type: "assist-request", source: "shortcut" });
}

function toggleDiscreet() {
  if (windows.mode === "discreet" && windows.overlayVisible) {
    windows.setDiscreet(false);
    return;
  }
  // Discreet input needs keyboard focus to type, but only the slim bar is shown.
  windows.showOverlay({ focus: true });
  windows.setDiscreet(true);
}

function toast(level: "info" | "error", message: string) {
  emitApp({ type: "toast", level, message });
}

/**
 * Capture the display under the cursor. Concurrent requests (held-down shortcut, ⌘⇧S then ⌘↵)
 * share one capture instead of hiding/showing the panel and grabbing the screen repeatedly.
 */
const captureCursorOnce = singleFlight(async () => {
  const started = performance.now();
  const rec = await captureAndAttach(null);
  core.metrics.recordCapture(performance.now() - started);
  return rec;
});

async function captureAndAttach(sourceId: string | null, region: null = null, opts: { restoreFocus?: boolean } = {}) {
  const wasVisible = windows.overlayVisible;
  windows.hideOverlay(); // the panel must not appear in its own capture
  await new Promise((r) => setTimeout(r, 150));
  try {
    const held = sourceId ? await capture.capture(sourceId) : await capture.captureCursorDisplay();
    const f = capture.finalize(held.captureId, region);
    return core.addCapture({ title: `Screen — ${f.title}`, sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl }).record;
  } finally {
    if (wasVisible) windows.showOverlay({ focus: opts.restoreFocus ?? false });
  }
}

async function askAboutScreen() {
  if (!core.settings.consent.screen) {
    windows.openMain("/main/permissions");
    toast("info", "Enable screen context in Permissions first.");
    return;
  }
  try {
    await captureCursorOnce();
    windows.showOverlay({ focus: false });
  } catch (err) {
    windows.showOverlay({ focus: false });
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
    windows.showOverlay({ focus: false });
    toast("info", "Copy the text you want to ask about (⌘/Ctrl+C), then press the shortcut again.");
    return;
  }
  core.addText("selected_text", `Selection — ${text.replace(/\s+/g, " ").slice(0, 40)}`, text);
  windows.showOverlay({ focus: false });
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
      recording ? { label: "Stop recording", click: () => core.stopTranscript() } : { label: "Live transcript…", click: () => windows.openMain("/main/transcript") },
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
const secretName = z.enum(["anthropic", "openai", "gemini", "deepgram", "openai_compat"]);

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
  handle("settings:shortcutStatus", () => shortcuts.status());
  handle("assist:prepare", async () => {
    // Capture only when screen context is authorized; otherwise rely on other authorized sources.
    let shot: { captured: boolean; pending: string | null; error: string | null } = { captured: false, pending: null, error: null };
    if (core.settings.consent.screen) {
      try {
        const rec = await captureCursorOnce();
        shot = { captured: true, pending: rec.status === "pending" ? rec.id : null, error: null };
      } catch (err) {
        shot = { captured: false, pending: null, error: (err as Error).message };
      }
    }
    return { ...core.assistPlan(), capture: shot };
  });

  // ---- secrets & providers ----
  const secretsStatus = () => ({
    anthropic: secrets.has("anthropic"),
    deepgram: secrets.has("deepgram"),
    openai_compat: secrets.has("openai_compat"),
    openai: secrets.has("openai"),
    gemini: secrets.has("gemini"),
    encryptionAvailable: secrets.encryptionAvailable,
    unreadable: [...secrets.unreadable],
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
    ai: z
      .object({
        model: z
          .string()
          .regex(/^[a-z0-9.-]{3,64}$/)
          .optional(),
        effort: effortEnum.optional(),
        style: styleEnum.optional(),
      })
      .optional(),
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
      defaultPath: `lumen-session-${data.session.title.replace(/[^\w-]+/g, "-").slice(0, 40)}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Plain text", extensions: ["txt"] },
        { name: "JSON (full backup)", extensions: ["json"] },
      ],
    });
    if (res.canceled || !res.filePath) return null;
    const fmt = formatFromPath(res.filePath);
    const md = fmt === "json" ? "" : sessionToMarkdown(data);
    writeFileAtomic(res.filePath, fmt === "json" ? JSON.stringify(data, null, 2) : fmt === "txt" ? markdownToText(md) : md, 0o600);
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
    depth: z.enum(["quick", "balanced", "deep"]).optional(),
    // Mode prompts are rebuilt in the main process from structured fields; free-form instructions
    // from the renderer are not accepted.
    mode: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("technical"),
          task: z.enum(["solve", "explain", "debug", "review", "tests", "complexity", "refactor", "hints", "system_design"]),
          language: z.enum(["python", "java", "javascript", "typescript", "cpp", "sql", "go", "csharp", "kotlin", "rust"]),
          problem: str(60_000).optional(),
          detail: z.enum(["concise", "full"]).optional(),
        }),
        z.object({ kind: z.literal("interview"), question: str(4000), length: z.enum(["short", "medium", "detailed"]) }),
      ])
      .optional(),
  });
  handle("chat:send", (_e, req) => {
    const { mode, ...r } = chatReq.parse(req);
    // Requests are always bound to the active session; a stale renderer cannot target another one.
    if (mode?.kind === "technical") void core.sendTechnical({ ...r, task: mode.task, language: mode.language, problem: mode.problem, detail: mode.detail });
    else if (mode?.kind === "interview") void core.sendInterview({ ...r, question: mode.question, length: mode.length });
    else void core.send({ ...r, sessionId: core.activeSessionId });
  });
  handle("chat:cancel", (_e, rid) => core.chat.cancel(id.parse(rid)));
  handle("technical:analyze", (_e, text) => {
    const t = str(60_000).parse(text);
    const p = core.analyzeProblem(t);
    return { ...p, source: t.trim() ? "text" : p.statement ? "screen" : "none" };
  });
  const profileSection = z.enum(["resume", "experience", "projects", "skills", "accomplishments", "challenges", "target", "style"]);
  handle("profile:get", () => core.profileText());
  handle("profile:save", (_e, section, text) => {
    core.saveProfileSection(profileSection.parse(section), str(100_000).parse(text));
    return core.profileText();
  });
  handle("interview:questions", () => core.copilot.questions.map((q) => ({ id: q.id, text: q.text, category: q.category, categoryLabel: CATEGORY_LABELS[q.category], startMs: q.startMs })));
  const notesPatch = z
    .object({
      summary: str(20_000),
      keyPoints: z.array(str(2000)).max(200),
      discussionPoints: z.array(str(2000)).max(200),
      topics: z.array(str(500)).max(200),
      decisions: z.array(str(2000)).max(200),
      actionItems: z.array(z.object({ task: str(2000), owner: str(200).nullable() })).max(200),
      unansweredQuestions: z.array(str(2000)).max(200),
      followUpPrep: z.array(str(2000)).max(200),
      conceptsToRevisit: z.array(str(500)).max(200),
      followUpEmail: z.object({ subject: str(500), body: str(20_000) }),
    })
    .partial();
  handle("notes:update", (_e, tid, patch) => core.updateNotes(id.parse(tid), notesPatch.parse(patch)));
  handle("notes:export", async (e, tid, includeTranscript) => {
    const { filename, markdown } = core.exportNotes(id.parse(tid), z.boolean().parse(includeTranscript));
    const res = await dialog.showSaveDialog(winOf(e), {
      defaultPath: filename,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    if (res.canceled || !res.filePath) return null;
    writeFileAtomic(res.filePath, formatFromPath(res.filePath) === "txt" ? markdownToText(markdown) : markdown, 0o600);
    return res.filePath;
  });
  handle("history:list", () => store.listConversations(core.activeSessionId));
  handle("history:openConversation", () => core.openConversation());
  handle("history:setOpenConversation", (_e, cid) => core.setOpenConversation(id.nullable().parse(cid)));
  handle("usage:today", () => core.spendToday());
  handle("app:info", () => ({ packaged: app.isPackaged, devModeAllowed: core.devModeAllowed, version: app.getVersion() }));
  handle("platform:profile", () => currentPlatform());
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
  // ---- project memory (user-approved, durable) ----
  const memoryKind = z.enum(["preference", "convention", "architecture", "decision", "known_issue", "task"]);
  handle("memory:list", () => core.memory.list());
  handle("memory:add", (_e, kind, text, ttlDays) =>
    core.memory.add(memoryKind.parse(kind), str(2000).parse(text), {
      sessionId: null,
      ttlDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .nullable()
        .parse(ttlDays ?? null),
    }),
  );
  handle("memory:update", (_e, mid, patch) => core.memory.update(id.parse(mid), z.object({ text: str(2000).optional(), kind: memoryKind.optional() }).parse(patch)));
  handle("memory:delete", (_e, mid) => core.memory.delete(id.parse(mid)));
  // ---- hybrid inference: local runtime (loopback only), usage, caches, embeddings ----
  handle("local:status", async () => {
    await core.local.refresh();
    const st = core.local.state();
    const model = core.settings.inference.local.embeddingModel;
    return { ...st, embeddingIndex: core.embeddings.state(model) };
  });
  handle("local:loaded", async () => {
    const rt = core.local.runtime();
    return rt ? rt.loaded().catch(() => []) : [];
  });
  let embedJob: AbortController | null = null;
  handle("local:buildIndex", async (_e, rebuild) => {
    if (embedJob) throw new Error("The index is already being built.");
    embedJob = new AbortController();
    try {
      const added = await core.embeddings.build(core.settings.inference.local.embeddingModel, { rebuild: z.boolean().parse(rebuild), signal: embedJob.signal });
      logger.info("embedding index built", { added });
      return { added, state: core.embeddings.state(core.settings.inference.local.embeddingModel) };
    } finally {
      embedJob = null;
    }
  });
  handle("local:stopIndex", () => embedJob?.abort());
  handle("local:clearIndex", () => store.clearEmbeddings());
  handle("usage:report", (_e, days) => ({ rows: core.usage.report(z.number().int().min(1).max(90).parse(days)), budget: core.usage.status(core.activeSessionId) }));
  handle("cache:stats", () => core.responseCache.stats());
  handle("cache:clear", () => core.responseCache.clear());

  // ---- quality loop (local only; nothing is sent anywhere) ----
  const feedbackKind = z.enum(["helpful", "incorrect", "incomplete", "irrelevant_context", "too_slow", "too_verbose", "bad_formatting", "other"]);
  handle("quality:addFeedback", (_e, input) => {
    const r = z.object({ messageId: id.nullable(), kind: feedbackKind, note: z.string().max(2000).optional(), expected: z.string().max(4000).optional() }).parse(input);
    return core.quality.addFeedback(r);
  });
  handle("quality:listFeedback", () => core.quality.listFeedback());
  handle("quality:deleteFeedback", (_e, fid) => core.quality.deleteFeedback(id.parse(fid)));
  handle("quality:metrics", (_e, days) => core.quality.metrics(z.number().int().min(1).max(365).parse(days)));
  handle("quality:proposals", () => {
    const ev = store.qualityEvents(Date.now() - 30 * 86_400_000);
    const runs = evals.list();
    const latest = runs.find((r) => r.mode === "deterministic" && r.status === "complete");
    const latestRun = latest ? evals.get(latest.id) : null;
    const baselineId = runs.find((r) => r.isBaseline)?.id;
    const baselineComparison = baselineId && latest && latest.id !== baselineId ? evals.compare(baselineId, latest.id) : null;
    return buildProposals({ events: ev, feedback: core.quality.listFeedback(), latestRun, baselineComparison });
  });
  handle("quality:draftCase", (_e, fid) => core.quality.draftCase(id.parse(fid)));
  handle("quality:saveCase", (_e, def, fid) => core.quality.saveCase(z.record(z.string(), z.unknown()).parse(def) as never, fid == null ? null : id.parse(fid)));
  handle("quality:userCases", () => core.quality.userCases());
  handle("quality:deleteUserCase", (_e, cid) => store.deleteUserCase(z.string().max(60).parse(cid)));
  handle("quality:clear", () => store.clearQuality());

  // ---- evaluation lab (synthetic benchmark; live runs need explicit confirmation) ----
  const limitsSchema = z
    .object({
      maxCases: z.number().int().min(1).max(500),
      concurrency: z.number().int().min(1).max(4),
      maxOutputTokens: z.number().int().min(64).max(8000),
      maxCostUsd: z.number().min(0).max(25),
      caseTimeoutMs: z.number().int().min(1000).max(300_000),
    })
    .partial();
  const variantSchema = z.object({
    name: z.string().min(1).max(60),
    promptVersion: z.string().max(40).optional(),
    contextBudgetChars: z.number().int().min(1000).max(200_000).optional(),
    verification: z.boolean().optional(),
    model: z.string().max(100).optional(),
  });
  const startSchema = z.object({
    mode: z.enum(["deterministic", "live"]),
    caseIds: z.array(z.string().max(40)).max(500).optional(),
    categories: z.array(z.string().max(40)).max(20).optional(),
    collection: z.enum(["benchmark", "user", "all"]).optional(),
    repeat: z.number().int().min(1).max(5).optional(),
    limits: limitsSchema.optional(),
    variant: variantSchema.optional(),
    label: z.string().max(80).optional(),
    confirmLive: z.boolean().optional(),
    experiment: z.object({ name: z.string().min(1).max(80), variants: z.array(variantSchema).min(2).max(4) }).optional(),
  });
  handle("eval:catalog", () => evals.catalog());
  handle("eval:estimate", (_e, req) => evals.estimate(startSchema.parse(req)));
  handle("eval:start", (_e, req) => {
    const r = startSchema.parse(req);
    if (r.mode === "live") logger.info("live evaluation started", { cases: r.caseIds?.length ?? null, categories: r.categories?.length ?? null, repeat: r.repeat ?? 1 });
    evals.start(r);
  });
  handle("eval:stop", () => evals.stop());
  handle("eval:status", () => ({ running: evals.running }));
  handle("eval:list", () => evals.list());
  handle("eval:get", (_e, rid) => evals.get(id.parse(rid)));
  handle("eval:delete", (_e, rid) => evals.delete(id.parse(rid)));
  handle("eval:setBaseline", (_e, rid) => evals.setBaseline(rid === null ? null : id.parse(rid)));
  handle("eval:compare", (_e, a, b) => evals.compare(id.parse(a), id.parse(b)));
  handle("eval:export", async (e, rid) => {
    const json = evals.exportRun(id.parse(rid));
    const res = await dialog.showSaveDialog(winOf(e), { defaultPath: `lumen-eval-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (res.canceled || !res.filePath) return null;
    writeFileAtomic(res.filePath, json, 0o600);
    return res.filePath;
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
    await captureCursorOnce();
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
      list.unshift({
        id: l.id,
        sessionId: l.workspaceSessionId,
        title: `${l.title} (not saved)`,
        startedAt: l.started,
        endedAt: null,
        segmentCount: l.liveSegments().length,
        provider: "deepgram",
        persisted: false,
      });
    }
    return list;
  });
  handle("transcript:segments", (_e, tid) => {
    assertTranscriptInActive(id.parse(tid));
    return core.liveSegments(String(tid)) ?? store.listSegments(String(tid));
  });
  const ownSegment = (segId: unknown) => {
    const sid = id.parse(segId);
    if (store.segmentOwner(sid) !== core.activeSessionId) throw new Error("That transcript belongs to another session.");
    return sid;
  };
  handle("transcript:updateSegment", (_e, segId, text, speaker) => store.updateSegment(ownSegment(segId), str(10_000).parse(text), str(60).nullable().parse(speaker)));
  handle("transcript:deleteSegment", (_e, segId) => store.deleteSegment(ownSegment(segId)));
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
    core.audioCaptureFailed(kind === "system" ? "system" : "microphone", String(message));
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
    writeFileAtomic(res.filePath, JSON.stringify(store.exportAll(), null, 2), 0o600);
    return res.filePath;
  });
  handle("data:deleteAll", () => {
    capture.clearAll();
    core.deleteAll();
    evals.stop();
    evals.clearHistory();
    updateTray();
    logger.info("all user data deleted");
  });
  handle("diagnostics:get", () => diagnostics());
  handle("diagnostics:rendererCrash", (e, report) => {
    const r = z.object({ name: z.string().max(80), components: z.string().max(400) }).parse(report);
    logger.error("renderer crashed", { window: winOf(e) === windows.overlay ? "overlay" : "main", error: r.name, components: r.components });
  });
  handle("diagnostics:saveSupportBundle", async (e) => {
    const res = await dialog.showSaveDialog(winOf(e), {
      defaultPath: `lumen-support-${app.getVersion()}-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.canceled || !res.filePath) return null;
    let logText = "";
    try {
      logText = fs.readFileSync(logger.file, "utf8");
    } catch {
      /* no log yet */
    }
    const d = diagnostics();
    // Request rows carry only timings and token counts, but drop them to keep the file small.
    const q = core.quality.metrics(30);
    const slim = {
      ...d,
      metrics: { ...d.metrics, requests: d.metrics.requests.slice(0, 20) },
      os: { type: os.type(), release: os.release(), arch: os.arch(), memoryGb: Math.round(os.totalmem() / 1e8) / 10 },
      schemaVersion: store.schemaVersion(),
      // Counts and rates only — no feedback notes, questions or answers.
      quality: { requests: q.requests, successRate: q.successRate, failuresByCode: q.failuresByCode, verificationByCheck: q.verificationByCheck, feedbackByKind: q.feedbackByKind, latency: q.latency },
      inference: { mode: core.settings.inference.mode, privacyRestricted: core.settings.inference.privacyRestricted, localRuntime: core.local.state().status?.available ?? null },
    };
    writeFileAtomic(res.filePath, buildSupportBundle({ diagnostics: slim as unknown as Record<string, unknown>, logText, home: os.homedir(), now: new Date() }), 0o600);
    logger.info("support bundle saved");
    return res.filePath;
  });
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
    const a = z.enum(["hide", "toggle", "expand", "compact", "discreet", "reset-position"]).parse(action);
    if (a === "hide") windows.hideOverlay();
    else if (a === "toggle") windows.toggleOverlay({ focus: true });
    else if (a === "expand") windows.setMode("expanded");
    else if (a === "compact") windows.setMode("compact");
    else if (a === "discreet") windows.setDiscreet(windows.mode !== "discreet");
    else windows.resetPosition();
  });
  handle("overlay:setSize", (_e, w, h) => windows.setOverlaySize(z.number().parse(w), z.number().parse(h)));
  handle("app:openMain", (_e, route) => {
    windows.openMain(
      route
        ? z
            .string()
            .regex(/^\/main\/[a-z-]+$/)
            .parse(route)
        : undefined,
    );
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
    platformProfile: currentPlatform(),
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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
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

app.on("second-instance", (_e, argv) => {
  if (wantsToggle(argv)) windows?.toggleOverlay({ focus: false });
  else windows?.showOverlay();
});

/**
 * Graceful shutdown: stop capture first (releases mic and screen), cancel in-flight answers and
 * give them a bounded moment to write their final state, then close the database. `will-quit`
 * is synchronous, so the async part runs in `before-quit` and re-triggers quit when done.
 */
let shuttingDown = false;
let shutdownDone = false;
app.on("before-quit", (e) => {
  if (shutdownDone || !core) return;
  e.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      shortcuts?.releaseAll();
      globalShortcut.unregisterAll();
      core.stopTranscript();
      core.stopLiveScreen();
      await core.shutdown(1500);
      await ocr.dispose();
      store?.close();
      logger.info("shutdown complete");
    } catch (err) {
      logger.error("shutdown error", { message: (err as Error).message });
    } finally {
      shutdownDone = true;
      app.quit();
    }
  })();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
app.on("activate", () => windows.openMain());

process.on("uncaughtException", (err) => logger.error("uncaught exception", { message: err.message, stack: err.stack }));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { message: String(err) }));

const ocr = new TesseractOcr({ timeoutMs: 30_000 });

function fatalStartup(err: unknown) {
  const message = (err as Error)?.message ?? String(err);
  logger.error("startup failed", { message });
  dialog.showErrorBox(
    "Lumen could not start",
    /newer Lumen/.test(message)
      ? "Your data was created by a newer version of Lumen. Install the latest version to open it. Your data has not been changed."
      : `Lumen could not open its data folder:\n\n${userData}\n\n${message.replace(userData, "<data folder>")}\n\nCheck that the disk is not full and that the folder is writable, then try again.`,
  );
  app.exit(1);
}

void app.whenReady().then(startup).catch(fatalStartup);

function startup() {
  cleanupTempFiles(userData);
  const opened = openStore(path.join(userData, "lumen.db"));
  store = opened.store;
  if (opened.outcome.kind === "migrated") logger.info("database migrated", { from: opened.outcome.from, to: opened.outcome.to });
  if (opened.outcome.kind === "recovered") {
    logger.error("database recovered", { reason: opened.outcome.reason });
    startupNotice = `Lumen's database could not be opened (${opened.outcome.reason}), so a fresh one was created. The previous file was kept at ${opened.outcome.quarantined} and was not deleted.`;
  }
  const settings = loadSettingsJson(store.getKv("settings"));
  logger.level = settings.diagnostics.logLevel;

  core = new AppCore(
    {
      store,
      secrets,
      ocr,
      emitChat: (e) => {
        windows?.broadcast("lumen:chat", e);
        // An interview suggestion finishing while the panel is hidden gets a quiet OS notification.
        if (e.type === "done" && e.requestId.startsWith("iq-") && !windows?.overlayVisible) {
          notify("Lumen — suggested answer ready", "Press the show/hide shortcut to view it.", () => windows.showOverlay({ focus: false }));
        }
      },
      emitTranscript: (e) => {
        windows?.broadcast("lumen:transcript", e);
        if (e.type === "status") updateTray();
      },
      emitApp: (e) => {
        emitApp(e);
        if (e.type === "live-screen") updateTray();
      },
      log: (level, msg, data) => logger.log(level, msg, data),
      devModeAllowed: !app.isPackaged || process.env.LUMEN_ALLOW_DEV_MODE === "1",
      appVersion: app.getVersion(),
      liveScreenCapture: async () => {
        // Live sampling captures the display under the cursor. The overlay is a normal window, so
        // it may appear in the frame; that is visible to the user and harmless.
        const held = await capture.captureCursorDisplay();
        const f = capture.finalize(held.captureId, null);
        return { title: f.title, sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl, fingerprint: f.fingerprint };
      },
    },
    settings,
    (s) => store.setKv("settings", JSON.stringify(s)),
  );
  evals = new EvalService({
    userCases: () => core.quality.userCases().map((u) => u.case),
    onUserCaseResult: (cid, result) => store.setUserCaseRun(cid, result),
    store: new EvalStore(path.join(userData, "evaluations"), os.homedir()),
    getSettings: () => core.settings,
    // A live run measures the selected provider; selecting "Local model" benchmarks the local model.
    getProvider: async () => {
      if (core.settings.provider.kind !== "ollama") return core.providerFor();
      await core.local.refresh();
      return core.local.provider();
    },
    describeLocal: async () => {
      const rt = core.local.runtime();
      if (!rt) return { runtimeVersion: null, loaded: [] };
      const st = await rt.status();
      return { runtimeVersion: st.version, loaded: await rt.loaded().catch(() => []) };
    },
    emit: (e) => windows?.broadcast("lumen:eval", e),
  });
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
  initShortcuts();
  createTray();
  if (process.platform === "darwin") app.dock?.hide();
  windows.createOverlay();
  if (!core.settings.onboardingComplete) windows.openMain("/main/onboarding");
  else windows.showOverlay();

  registerLifecycle();
  if (startupNotice) {
    const notice = startupNotice;
    setTimeout(() => void dialog.showMessageBox({ type: "warning", title: "Lumen recovered your data", message: "Lumen started with a fresh database", detail: notice }), 800);
  }
  if (process.env.LUMEN_SMOKE_TEST) void import("./smoke.js").then((m) => m.runSmokeTest({ app, core, store, windows, capture, shortcutStatus, shortcuts }));
}

let startupNotice: string | null = null;

/** Sleep/resume, display changes and renderer crashes. */
function registerLifecycle() {
  let wasRecording = false;
  powerMonitor.on("suspend", () => {
    // Audio devices and network sockets do not survive sleep reliably; pause rather than
    // silently losing audio, and tell the user on wake.
    wasRecording = !!core.live && ["recording", "reconnecting", "connecting"].includes(core.live.status);
    if (wasRecording) core.pauseTranscript();
    if (core.liveScreenState.active && !core.liveScreenState.paused) core.liveScreen.pause();
    logger.info("system suspend", { wasRecording });
  });
  powerMonitor.on("resume", () => {
    windows.ensureOverlayVisible();
    if (wasRecording) toast("info", "Recording was paused while your computer slept. Press Resume to continue.");
    wasRecording = false;
    logger.info("system resume");
  });
  windows.onRendererGone = (role, reason) => {
    logger.error("renderer gone", { role, reason });
    // The overlay hosts audio capture; if it died the microphone stream is gone too.
    if (role === "overlay" && core.live && core.live.status !== "stopped") {
      core.stopTranscript("The assistant panel restarted unexpectedly, so recording stopped. Your transcript so far was kept.");
    }
  };
}
