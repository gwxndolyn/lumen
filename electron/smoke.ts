import type { App, BrowserWindow } from "electron";
import { nativeImage } from "electron";
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
    ];
    const broken: string[] = [];
    for (const r of routes) {
      await js(`location.hash = '/main/${r}'`);
      await wait(300);
      if (!(await js<boolean>("document.querySelector('.page-header h1') !== null"))) broken.push(r);
      if (["interview", "technical", "sessions", "knowledge", "diagnostics", "provider", "transcript", "history", "shortcuts", "evaluation", "quality"].includes(r)) await shot(win, `05-${r}`);
    }
    check("screensRender", broken.length === 0, broken);

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
