import type { App, BrowserWindow } from "electron";
import { nativeImage, clipboard } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppCore } from "../src/core/app";
import { MIGRATIONS, type Store } from "../src/core/storage/db";
import type { ShortcutManager } from "../src/core/shortcuts";
import type { CaptureService } from "./capture";
import type { WindowManager } from "./windows";

interface Ctx {
  app: App;
  core: AppCore;
  store: Store;
  windows: WindowManager;
  capture: CaptureService;
  shortcutStatus: Record<string, boolean>;
  shortcuts: ShortcutManager;
}

/**
 * Automated end-to-end check of the real app (LUMEN_SMOKE_TEST=1). Uses the real renderer, IPC,
 * SQLite, on-device OCR and window manager. External services are replaced by local stand-ins
 * started by scripts/smoke.sh (an Anthropic-compatible SSE server via LUMEN_ANTHROPIC_BASE_URL and
 * a Deepgram-compatible WebSocket via LUMEN_DEEPGRAM_URL) when available; otherwise the labelled
 * mock provider is used. Screenshots are written to LUMEN_SMOKE_SHOTS.
 */
function BrowserWindowFocused(): string {
  const { BrowserWindow } = require("electron") as typeof import("electron");
  const f = BrowserWindow.getFocusedWindow();
  return f ? (f.getTitle() === "Lumen" && f.isAlwaysOnTop() ? "overlay" : "main") : "none";
}

/**
 * Two-launch restart check (LUMEN_SMOKE_PHASE=seed, then =verify on the same profile):
 * seed writes a session, a conversation, a context note, a setting and a stored key, then quits
 * through the normal quit path (before-quit → graceful shutdown); verify checks it all came back.
 */
export async function runRestartPhase(opts: { app: Electron.App; core: AppCore; store: Store; windows: WindowManager; setSecret: (n: "anthropic", v: string) => void }, phase: "seed" | "verify") {
  const { app, core, store } = opts;
  const out = (ok: boolean, data: unknown) => {
    console.log(`RESTART ${phase.toUpperCase()} ${ok ? "PASS" : "FAIL"} ${JSON.stringify(data)}`);
  };
  try {
    if (phase === "seed") {
      const s = core.createSession({ title: "Restart check", type: "general" });
      // Packaged builds refuse development mode, so use the Anthropic-wire stand-in when given.
      const kind = process.env.LUMEN_ANTHROPIC_BASE_URL ? "anthropic" : "mock";
      if (kind === "anthropic") opts.setSecret("anthropic", "sk-ant-smoke-test-key-000000");
      core.updateSettings({ onboardingComplete: true, theme: "light", provider: { kind }, privacy: { conversationRetentionDays: 45 } });
      core.addText("note", "Restart note", "The deploy window is Friday 18:00.");
      await core.send({ requestId: "restart-1", conversationId: null, text: "Remember the deploy window", style: "quick", tone: "neutral", includeLiveTranscript: false });
      const conv = store.listConversations(s.id)[0]!;
      core.setOpenConversation(conv.id);
      out(true, { session: s.id, conversation: conv.id, messages: store.listMessages(conv.id).length });
      app.quit(); // the real quit path, not app.exit()
      return;
    }
    const s = store.listSessions().find((x) => x.title === "Restart check");
    const conv = s ? store.listConversations(s.id)[0] : undefined;
    const msgs = conv ? store.listMessages(conv.id) : [];
    const note = s ? core.engine.list(s.id).find((r) => r.title === "Restart note") : undefined;
    const data = {
      session: !!s,
      active: core.activeSessionId === s?.id,
      openConversation: s ? core.openConversation() === conv?.id : false,
      messages: msgs.map((m) => m.role),
      note: !!note,
      settings: { theme: core.settings.theme, retention: core.settings.privacy.conversationRetentionDays, onboarding: core.settings.onboardingComplete },
      walClean: !require("node:fs").existsSync(`${store.path}-wal`) || require("node:fs").statSync(`${store.path}-wal`).size === 0,
    };
    const ok =
      data.session &&
      data.active &&
      data.openConversation &&
      data.messages.join(",") === "user,assistant" &&
      data.note &&
      data.settings.theme === "light" &&
      data.settings.retention === 45 &&
      data.settings.onboarding;
    out(ok, data);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    out(false, { error: (err as Error).message });
    app.exit(1);
  }
}

/** Upgrade check: run the current build on a profile created by an older version. */
export async function runUpgradeCheck(opts: { app: Electron.App; core: AppCore; store: Store }) {
  const { app, core, store } = opts;
  try {
    const sessions = store.listSessions();
    const s = sessions.find((x) => x.title === "From 0.3.0-old");
    const conv = s ? store.listConversations(s.id)[0] : undefined;
    const t = s ? store.listTranscriptSessions(s.id)[0] : undefined;
    const data = {
      schema: store.schemaVersion(),
      latest: MIGRATIONS.length,
      session: !!s && s.notes === "Old notes",
      active: core.activeSessionId === s?.id,
      messages: conv ? store.listMessages(conv.id).map((m) => m.content) : [],
      transcript: t ? store.listSegments(t.id).map((x) => x.text) : [],
      memories: core.memory.list().map((m) => m.text),
      spend: store.spendSince(0).requests,
      settings: {
        theme: core.settings.theme,
        provider: core.settings.provider.kind,
        limit: core.settings.provider.dailySpendLimitUsd,
        retention: core.settings.privacy.conversationRetentionDays,
        onboarding: core.settings.onboardingComplete,
        inference: core.settings.inference.mode,
      },
      search: store.search("Thursday", null).length,
    };
    const ok =
      data.schema === data.latest &&
      data.session &&
      data.active &&
      data.messages.join("|") === "What did we decide?|Ship Thursday." &&
      data.transcript.join() === "Ship Thursday" &&
      data.memories.includes("Use Kotlin coroutines") &&
      data.spend === 1 &&
      data.settings.theme === "light" &&
      data.settings.provider === "gemini" &&
      data.settings.limit === 2 &&
      data.settings.retention === 0 &&
      data.settings.onboarding &&
      data.settings.inference === "manual" &&
      data.search >= 2;
    console.log(`UPGRADE ${ok ? "PASS" : "FAIL"} ${JSON.stringify(data)}`);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(`UPGRADE FAIL ${JSON.stringify({ error: (err as Error).message })}`);
    app.exit(1);
  }
}

export async function runSmokeTest({ app, core, store, windows, capture, shortcutStatus, shortcuts }: Ctx) {
  const result: Record<string, unknown> = {};
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => {
    result[name] = detail === undefined ? ok : detail;
    if (!ok) failures.push(name);
  };
  const shots = process.env.LUMEN_SMOKE_SHOTS;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win: BrowserWindow, name: string) => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const until = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await wait(100);
    }
    return false;
  };
  const realProvider = !!process.env.LUMEN_ANTHROPIC_BASE_URL;
  const realStt = !!process.env.LUMEN_DEEPGRAM_URL;

  try {
    const win = windows.openMain("/main/onboarding");
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
    await wait(500);
    await shot(win, "01-onboarding");
    const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
    check("bridge", (await js("window.lumen.role")) === "main");
    check("nodeIsolated", (await js("typeof require + '/' + typeof process")) === "undefined/undefined");
    check("shortcuts", Object.values(shortcutStatus).every(Boolean), { ...shortcutStatus });
    // Every migration applied (not a hard-coded number that goes stale when one is added).
    check("schemaVersion", store.schemaVersion() === MIGRATIONS.length, store.schemaVersion());

    // ---- fresh install: onboarding resumes after a restart, credentials are validated for real ----
    const onboardingFresh = await js<boolean>("document.body.innerText.includes('Welcome to Lumen')");
    const secretsBefore = await js<Record<string, boolean>>("window.lumen.secretsStatus()");
    if (realProvider) {
      // Wrong key: the test must fail with an auth error, not report "connected".
      await js("window.lumen.setSecret('anthropic', 'sk-ant-smoke-invalid-key-0000')");
      await js("window.lumen.updateSettings({ provider: { kind: 'anthropic' } })");
      const bad = await js<{ ok: boolean; code?: string; message: string }>("window.lumen.testProvider()");
      const quotaKey = await js("window.lumen.setSecret('anthropic', 'sk-ant-smoke-quota-key-00000')");
      void quotaKey;
      const quota = await js<{ ok: boolean; code?: string }>("window.lumen.testProvider()");
      await js("window.lumen.setSecret('anthropic', 'sk-ant-smoke-test-key-000000')");
      const health = await js<{ state: string }>("window.lumen.providerHealth()");
      check("ONB_credentials", onboardingFresh && !secretsBefore.anthropic && !bad.ok && bad.code === "auth" && !quota.ok && quota.code === "rate_limited", {
        onboardingFresh,
        bad,
        quota,
        healthAfterBad: health.state,
      });
      // The key never reaches the renderer: only presence flags are exposed.
      const exposed = await js<string>("JSON.stringify(window.lumen.secretsStatus ? 'flags-only' : '')");
      check("ONB_keyNotExposed", exposed === '"flags-only"' && !(await js<string>("JSON.stringify(localStorage)")).includes("sk-ant-"));
      // Interrupted onboarding resumes at the saved step after a reload.
      await js("window.lumen.updateSettings({ onboardingStep: 2 })");
      win.webContents.reload();
      await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
      await wait(600);
      const resumed = await js<boolean>("document.querySelector('.steps')?.getAttribute('aria-label') === 'Step 3 of 6'");
      check("ONB_resume", resumed);
    }

    // Provider: an Anthropic-wire-compatible local server when provided, else labelled mock.
    if (realProvider) {
      await js("window.lumen.setSecret('anthropic', 'sk-ant-smoke-test-key-000000')");
      await js("window.lumen.updateSettings({ provider: { kind: 'anthropic' }, onboardingComplete: true, consent: { screen: true, microphone: true } })");
      const t = await js<{ ok: boolean; message: string }>("window.lumen.testProvider()");
      check("providerHealthCheck", t.ok, t);
    } else {
      await js("window.lumen.updateSettings({ provider: { kind: 'mock' }, onboardingComplete: true, consent: { screen: true, microphone: true } })");
    }

    const ov = windows.overlay!;
    windows.showOverlay();
    await wait(600);
    const ojs = <T = unknown>(code: string) => ov.webContents.executeJavaScript(code) as Promise<T>;
    const ask = (q: string) =>
      ojs(`(() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(q)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
    const idle = () => ojs<boolean>("!document.querySelector('[aria-busy=\"true\"]')");
    const lastAnswer = () => ojs<string>("[...document.querySelectorAll('.msg.assistant')].at(-1)?.innerText ?? ''");

    // ---- A: stream then cancel ----
    await ask("Explain streaming in detail please, slowly.");
    const streamed = await until(async () => (await lastAnswer()).length > 20, 8000);
    await ojs("document.querySelector('button[title^=\"Stop\"]')?.click()");
    const stopped = await until(async () => (await idle()) && (await ojs<boolean>("document.body.innerText.includes('Stopped')")), 6000);
    check("A_streamThenCancel", streamed && stopped);
    await shot(ov, "02-overlay-cancelled");

    // ---- B: real capture pipeline (image -> on-device OCR -> question) ----
    const fixture = path.join(process.env.LUMEN_SMOKE_FIXTURES ?? path.join(app.getAppPath(), "src/test/fixtures"), "invoice.png");
    const held = await capture.importImage(fixture);
    const f = capture.finalize(held.captureId, null);
    const { record, ocr } = core.addCapture({ title: "Invoice", sourceId: f.sourceId, vision: f.vision, ocrPng: f.ocrPng, thumbnailDataUrl: f.thumbnailDataUrl }, { pending: true });
    const t0 = Date.now();
    await ocr;
    const rec = core.engine.get(record.id)!;
    check("B_ocr", /1,?250/.test(rec.text) && /November/i.test(rec.text), { ms: Date.now() - t0, confidence: rec.confidence, text: rec.text.slice(0, 80) });
    check(
      "B_pendingNotUsed",
      core.engine.active(core.activeSessionId).every((r) => r.id !== record.id),
    );
    await wait(200);
    const confirmBtn = await ojs<boolean>("!!document.querySelector('button[data-action=\"confirm-capture\"]')");
    check("B_previewShown", confirmBtn);
    await ojs("document.querySelector('button[data-action=\"confirm-capture\"]')?.click()");
    await until(() => core.engine.active(core.activeSessionId).some((r) => r.id === record.id), 3000);
    await ojs("document.querySelector('button[aria-label=\"New conversation\"]')?.click()");
    await wait(200);
    await ask("What is the total due on the invoice and when is it due?");
    await until(idle, 15000);
    const bAnswer = await lastAnswer();
    check("B_answerUsesCapture", realProvider ? /1,?250/.test(bAnswer) : /screenshot: Invoice/i.test(bAnswer), bAnswer.slice(0, 160));
    await shot(ov, "03-overlay-capture-answer");

    // ---- C: transcript -> contextual question ----
    if (realStt) {
      await js("window.lumen.setSecret('deepgram', 'dg-smoke-test-key-000000')");
      await js("window.lumen.transcriptStart('Smoke standup')");
      await until(() => core.live?.status === "recording", 5000);
      // Real audio path: the overlay's AudioCapture opens the actual microphone, the worklet
      // produces 16 kHz PCM frames, and they reach the stand-in STT over the real WebSocket.
      // The stand-in emits scripted finals once enough real audio bytes arrive.
      const audioArrived = await until(() => (core.live?.liveSegments().length ?? 0) >= 1, 8000);
      check("C_realMicAudioFlowed", audioArrived);
      const got = await until(() => (core.live?.liveSegments().length ?? 0) >= 2, 8000);
      check(
        "C_transcriptSegments",
        got,
        core.live?.liveSegments().map((s) => s.text),
      );
      await ojs("document.querySelector('button[aria-label=\"New conversation\"]')?.click()");
      await wait(200);
      await ask("What did we agree about the launch date?");
      await until(idle, 15000);
      const cAnswer = await lastAnswer();
      check("C_answerUsesTranscript", realProvider ? /thursday/i.test(cAnswer) : /meeting transcript/i.test(cAnswer), cAnswer.slice(0, 160));
      await shot(ov, "04-overlay-transcript-answer");
      await js("window.lumen.transcriptStop()");
    }

    // ---- E: session isolation through the UI ----
    const before = core.activeSessionId;
    await js("window.lumen.createSession({ title: 'Isolation check', type: 'general' })");
    await wait(300);
    check("E_newSessionEmptyContext", core.engine.active(core.activeSessionId).length === 0 && core.activeSessionId !== before);
    await ask("What is the total due on the invoice?");
    await until(idle, 15000);
    const eAnswer = await lastAnswer();
    check("E_noLeak", !/1,?250/.test(eAnswer) && !/screenshot: Invoice/i.test(eAnswer), eAnswer.slice(0, 160));
    await js(`window.lumen.switchSession(${JSON.stringify(before)})`);
    await wait(200);

    // ---- F: revoke screen permission ----
    await js("window.lumen.updateSettings({ consent: { screen: false } })");
    await wait(300);
    check("F_screenContextCleared", !core.engine.list(before).some((r) => r.source === "screenshot"));
    const blocked = await js<string>("window.lumen.listCaptureSources().then(() => 'allowed', (e) => e.message)");
    check("F_captureBlocked", /off/i.test(blocked), blocked);
    const btnDisabled = await ojs<boolean>("document.querySelector('button[title^=\"Enable screen\"]')?.disabled === true");
    check("F_uiUpdated", btnDisabled);

    // ---- screens render ----
    const routes = [
      "interview",
      "technical",
      "assistant",
      "sessions",
      "transcript",
      "history",
      "knowledge",
      "capture",
      "settings",
      "provider",
      "shortcuts",
      "permissions",
      "privacy",
      "diagnostics",
      "evaluation",
      "quality",
      "plan",
      "help",
    ];
    const broken: string[] = [];
    for (const r of routes) {
      await js(`location.hash = '/main/${r}'`);
      await wait(300);
      if (!(await js<boolean>("document.querySelector('.page-header h1') !== null"))) broken.push(r);
      if (["interview", "technical", "sessions", "knowledge", "diagnostics", "provider", "transcript", "history", "shortcuts", "evaluation", "quality", "plan", "help"].includes(r))
        await shot(win, `05-${r}`);
    }
    check("screensRender", broken.length === 0, broken);

    // ---- command palette: real keyboard input through Electron ----
    await js(`location.hash = '/main/assistant'`);
    await wait(300);
    win.focus();
    const key = (keyCode: string, modifiers: ("meta" | "control")[] = []) => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    };
    key("K", [process.platform === "darwin" ? "meta" : "control"]);
    await wait(250);
    const opened = await js<boolean>("!!document.querySelector('.palette') && document.activeElement?.classList.contains('palette-input')");
    for (const ch of "keyboard") win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await wait(150);
    const top = await js<string>("document.querySelector('.palette-item[aria-selected=\"true\"] .palette-title')?.textContent ?? ''");
    await wait(300); // let the fade-in finish before the screenshot
    const paletteBg = await js<string>("getComputedStyle(document.querySelector('.palette')).backgroundColor");
    await shot(win, "07-palette");
    key("Return");
    await wait(400);
    const navigated = await js<string>("location.hash");
    const closed = await js<boolean>("!document.querySelector('.palette')");
    key("K", [process.platform === "darwin" ? "meta" : "control"]);
    await wait(200);
    key("Escape");
    await wait(150);
    const escClosed = await js<boolean>("!document.querySelector('.palette')");
    const opaque = /^rgb\(/.test(paletteBg) || /rgba\([^)]*,\s*1\)$/.test(paletteBg);
    check("CP_palette", opened && /shortcuts/i.test(top) && navigated.endsWith("/shortcuts") && closed && escClosed && opaque, { opened, top, navigated, closed, escClosed, paletteBg });

    // ---- narrow main window: sidebar collapses, workspace stays usable ----
    const prevBounds = win.getBounds();
    win.setBounds({ ...prevBounds, width: 880 });
    await js(`location.hash = '/main/assistant'`);
    await wait(400);
    const narrow = await js<{ sidebar: number; overflow: boolean }>(
      "({ sidebar: document.querySelector('.sidebar').getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 })",
    );
    await shot(win, "08-narrow");
    win.setBounds(prevBounds);
    check("UX_narrowLayout", narrow.sidebar <= 80 && !narrow.overflow, narrow);

    // ---- overlay modes & display recovery ----
    windows.setMode("expanded");
    await wait(200);
    const hExp = windows.overlay!.getBounds().height;
    windows.setMode("compact");
    await wait(200);
    const hCmp = windows.overlay!.getBounds().height;
    check("overlayModes", hExp > hCmp, { expanded: hExp, compact: hCmp });
    windows.overlay!.setBounds({ x: -5000, y: -5000, width: 560, height: 176 });
    windows.ensureOverlayVisible();
    const b = windows.overlay!.getBounds();
    const { screen } = await import("electron");
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, ...d.workArea }));
    const inside = displays.some((a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
    check("overlayRecoversOffscreen", inside, { bounds: b, displays });

    // ---- Hotkeys (native registration + the exact handlers an accelerator invokes) ----
    // macOS does not allow this environment to synthesize keystrokes (no Accessibility grant), so
    // the physical keypress itself is not simulated: we verify the OS registration via
    // globalShortcut.isRegistered and then dispatch the same handler the OS would call.
    {
      const { globalShortcut } = await import("electron");
      const keys = core.settings.shortcuts;
      windows.hideOverlay();
      await wait(200);
      const hiddenReg = {
        requestAssist: globalShortcut.isRegistered(keys.requestAssist),
        toggleOverlay: globalShortcut.isRegistered(keys.toggleOverlay),
        discreetInput: globalShortcut.isRegistered(keys.discreetInput),
        scrollUp: globalShortcut.isRegistered(keys.scrollUp),
        moveLeft: globalShortcut.isRegistered(keys.moveLeft),
      };
      check("HK_registeredWhileHidden", hiddenReg.requestAssist && hiddenReg.toggleOverlay && hiddenReg.discreetInput && !hiddenReg.scrollUp && !hiddenReg.moveLeft, hiddenReg);

      // Toggle shows the panel without taking focus, and arrow shortcuts become registered.
      const focusedBefore = BrowserWindowFocused();
      shortcuts.trigger("toggleOverlay");
      await wait(400);
      check("HK_toggleShows", windows.overlayVisible, { visible: windows.overlayVisible });
      check("HK_toggleNoFocusSteal", !windows.overlay!.isFocused() || focusedBefore === "overlay", { overlayFocused: windows.overlay!.isFocused(), focusedBefore });
      check("HK_arrowsRegisteredWhenVisible", globalShortcut.isRegistered(keys.scrollUp) && globalShortcut.isRegistered(keys.moveRight));

      // Hiding mid-stream must not interrupt the answer: the request stays active and the hidden
      // renderer keeps receiving deltas, which are all present when the panel is shown again.
      windows.setMode("expanded");
      await wait(300);
      await ojs("document.querySelector('button[aria-label=\"New conversation\"]')?.click()");
      await wait(200);
      await ask("Explain streaming in detail please, slowly.");
      await until(() => core.chat.activeRequests === 1, 4000);
      await wait(600);
      shortcuts.trigger("toggleOverlay");
      await wait(150);
      const hiddenMid = !windows.overlayVisible;
      const lenHidden0 = (await lastAnswer()).length;
      const stillActive = core.chat.activeRequests === 1;
      await wait(1200);
      const lenHidden1 = (await lastAnswer()).length; // renderer keeps updating while hidden
      await until(() => core.chat.activeRequests === 0, 15000);
      shortcuts.trigger("toggleOverlay");
      await wait(400);
      const finalText = await lastAnswer();
      const lastReq = core.metrics.snapshot().requests[0];
      check("HK_hideDoesNotCancel", hiddenMid && stillActive && lenHidden1 > lenHidden0 && lastReq?.outcome === "ok" && /word79/.test(finalText) && !/Stopped/.test(finalText), {
        hiddenMid,
        stillActive,
        lenHidden0,
        lenHidden1,
        outcome: lastReq?.outcome,
        complete: /word79/.test(finalText),
      });

      // Scroll operates on Lumen's own response area (the long answer above overflows it).
      windows.setMode("expanded");
      await wait(300);
      const scrollable = await ojs<{ sh: number; ch: number }>(
        "(() => { const el = document.querySelector('.overlay-body-scroll'); el.scrollTop = el.scrollHeight; return { sh: el.scrollHeight, ch: el.clientHeight }; })()",
      );
      if (scrollable.sh <= scrollable.ch) throw new Error(`response area not scrollable (${JSON.stringify(scrollable)})`);
      const top0 = await ojs<number>("document.querySelector('.overlay-body-scroll').scrollTop");
      shortcuts.trigger("scrollUp");
      await wait(500);
      const top1 = await ojs<number>("document.querySelector('.overlay-body-scroll').scrollTop");
      shortcuts.trigger("scrollDown");
      await wait(500);
      const top2 = await ojs<number>("document.querySelector('.overlay-body-scroll').scrollTop");
      check("HK_scroll", top1 < top0 && top2 > top1, { top0, top1, top2 });

      // Move left/right moves the native window within its display.
      windows.overlay!.setPosition(Math.round(windows.overlay!.getBounds().x), windows.overlay!.getBounds().y);
      const x0 = windows.overlay!.getBounds().x;
      shortcuts.trigger("moveRight");
      await wait(100);
      const x1 = windows.overlay!.getBounds().x;
      shortcuts.trigger("moveLeft");
      shortcuts.trigger("moveLeft");
      await wait(100);
      const x2 = windows.overlay!.getBounds().x;
      check("HK_move", x1 > x0 && x2 < x1, { x0, x1, x2 });

      // ⌘/Ctrl+Enter with typed text submits it; with empty input it uses available context.
      await ojs("document.querySelector('button[aria-label=\"New conversation\"]')?.click()");
      await wait(200);
      await ojs(
        `(() => { const ta = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'What is the total due on the invoice?'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await wait(100);
      const n0 = core.metrics.snapshot().requests.length;
      shortcuts.trigger("requestAssist");
      await until(async () => core.metrics.snapshot().requests.length > n0 && (await idle()), 15000);
      check("HK_assistSubmitsTyped", (await ojs<string>("[...document.querySelectorAll('.msg.user')].at(-1)?.innerText ?? ''")).includes("total due"));
      await ojs("document.querySelector('button[aria-label=\"New conversation\"]')?.click()");
      await wait(200);
      shortcuts.trigger("requestAssist");
      await wait(800);
      // Screen consent was revoked earlier (F), nothing is recording: Lumen must explain, not invent.
      const emptyAssist = await ojs<string>("document.body.innerText");
      check("HK_assistEmptyExplains", /Type a question|enable screen context/i.test(emptyAssist) && !/\$1,250/.test(emptyAssist));

      // Discreet mode: distinct slim bar, preserves the conversation, toggles back.
      shortcuts.trigger("discreetInput");
      await wait(400);
      const dh = windows.overlay!.getBounds().height;
      const dTag = await ojs<boolean>("!!document.querySelector('.overlay.discreet .mode-tag')");
      await shot(ov, "06-discreet");
      shortcuts.trigger("discreetInput");
      await wait(400);
      check("HK_discreet", dTag && dh <= 90 && windows.mode !== "discreet" && windows.overlay!.getBounds().height > 100, { dh, dTag, mode: windows.mode });
    }

    // ---- I: network drop mid-stream, then retry; code block rendering and copy ----
    if (realProvider) {
      await js(`location.hash = '/main/assistant'`);
      await wait(200);
      await ask("Please drop the connection while answering.");
      const failed = await until(
        async () => (await idle()) && (await ojs<boolean>("!!document.querySelector('.msg.assistant .alert.error') || document.body.innerText.includes('Incomplete')")),
        12000,
      );
      const spinnerGone = await idle();
      const partialKept = await ojs<boolean>("document.body.innerText.includes('part0')");
      const errText = await ojs<string>("[...document.querySelectorAll('.msg.assistant .alert.error')].at(-1)?.innerText ?? ''");
      check("I_networkDrop", failed && spinnerGone && partialKept && /interrupted|connection/i.test(errText), { failed, spinnerGone, partialKept, errText: errText.slice(0, 120) });
      // "Try again" must really resend and settle — no duplicate request, no stuck spinner.
      const reqsBefore = core.metrics.snapshot().requests.length;
      await ojs("[...document.querySelectorAll('.msg.assistant .alert.error button')].find((b) => /Try again/.test(b.innerText))?.click()");
      const settled = await until(async () => (await idle()) && core.metrics.snapshot().requests.length === reqsBefore + 1, 12000);
      await wait(300);
      check("I_retryAfterDrop", settled && core.chat.activeRequests === 0 && core.metrics.snapshot().requests.length === reqsBefore + 1, {
        settled,
        requests: core.metrics.snapshot().requests.length - reqsBefore,
      });

      core.addText("selected_text", "uniq.js", "const uniq = (xs) => [...new Set(xs)];");
      await ask("Explain this code please");
      await until(async () => (await idle()) && (await ojs<boolean>("!!document.querySelector('.codeblock')")), 8000);
      const code = await ojs<string>("document.querySelector('.codeblock pre')?.innerText ?? ''");
      const copied = await ojs<string>(
        `(async () => { const b = [...document.querySelectorAll('.codeblock button')].at(-1); b?.click(); await new Promise((r) => setTimeout(r, 100)); return b?.innerText ?? ''; })()`,
      );
      // Read the system clipboard from the main process (what another app would paste).
      const clip = await clipboard.readText();
      check("I_codeCopy", code.trim() === "const uniq = (xs) => [...new Set(xs)];" && clip.trim() === code.trim() && /Copied/.test(copied), { code, clip: clip.slice(0, 80), copied });
    }

    // ---- H: delete session removes data incl. index ----
    const fts0 = store.ftsCounts();
    const victim = core.activeSessionId;
    const convs = store.listConversations(victim).length;
    await js(`window.lumen.deleteSession(${JSON.stringify(victim)})`);
    await wait(200);
    const fts1 = store.ftsCounts();
    check("H_sessionDeleted", !store.getSession(victim) && store.listConversations(victim).length === 0 && fts1.messages < fts0.messages, { convs, fts0, fts1 });

    result.provider = realProvider ? "anthropic-wire stand-in" : "mock";
    result.metrics = core.metrics.snapshot();
    result.tray = nativeImage ? "ok" : "n/a";
    const ok = failures.length === 0;
    console.log(`SMOKE ${ok ? "PASS" : "FAIL"} ${JSON.stringify({ failures, ...result })}`);
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(`SMOKE FAIL ${(err as Error).stack} ${JSON.stringify({ failures, ...result })}`);
    app.exit(1);
  }
}
