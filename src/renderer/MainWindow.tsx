import { useEffect, useMemo, useState } from "react";
import { CommandPalette, buildCommands } from "./components/CommandPalette";
import type { LiveScreenState, SessionSummary } from "../shared/types";
import { MODE_LABELS } from "../shared/defaults";
import { api } from "./lib/api";
import { isRecordingStatus, useActiveSession, useAppEvent, useLiveTranscript, useProviderHealth, useSettings } from "./lib/hooks";
import { ProviderStatus, RecordingControls, Toasts, showToast, useTheme } from "./components/ui";
import { AssistantScreen } from "./screens/Assistant";
import { CaptureScreen } from "./screens/Capture";
import { DiagnosticsScreen } from "./screens/Diagnostics";
import { HistoryScreen } from "./screens/History";
import { KnowledgeScreen } from "./screens/Knowledge";
import { OnboardingScreen } from "./screens/Onboarding";
import { PermissionsScreen } from "./screens/Permissions";
import { PrivacyScreen } from "./screens/Privacy";
import { ProviderScreen } from "./screens/Provider";
import { SessionsScreen } from "./screens/Sessions";
import { SettingsScreen } from "./screens/Settings";
import { ShortcutsScreen } from "./screens/Shortcuts";
import { TranscriptScreen } from "./screens/Transcript";
import { InterviewScreen } from "./screens/Interview";
import { TechnicalScreen } from "./screens/Technical";
import { MemoryScreen } from "./screens/Memory";
import { EvaluationScreen } from "./screens/Evaluation";
import { QualityScreen } from "./screens/Quality";
import { PlanScreen } from "./screens/Plan";
import { HelpScreen } from "./screens/Help";
import { ReportScreen } from "./screens/Report";

const MODES: { route: string; label: string; sub: string }[] = [
  { route: "interview", label: "Interview", sub: "Copilot" },
  { route: "technical", label: "Technical", sub: "Assessment" },
  { route: "transcript", label: "Notetaker", sub: "Live notes" },
];

const NAV: { section?: string; route: string; label: string; icon: string }[] = [
  { route: "assistant", label: "Assistant", icon: "◎" },
  { route: "capture", label: "Screen context", icon: "▣" },
  { route: "knowledge", label: "Knowledge base", icon: "✦" },
  { route: "memory", label: "Project memory", icon: "◆" },
  { route: "history", label: "Session history", icon: "↺" },
  { route: "sessions", label: "Sessions", icon: "▦" },
  { section: "Settings", route: "settings", label: "General", icon: "⚙" },
  { route: "provider", label: "AI provider", icon: "⌁" },
  { route: "shortcuts", label: "Shortcuts", icon: "⌘" },
  { route: "permissions", label: "Permissions", icon: "⛉" },
  { route: "privacy", label: "Privacy & data", icon: "◐" },
  { route: "plan", label: "Plan & updates", icon: "★" },
  { route: "help", label: "Help", icon: "?" },
  { route: "report", label: "Send feedback", icon: "✉" },
  { section: "Developer", route: "diagnostics", label: "Diagnostics", icon: "≋" },
  { route: "quality", label: "Quality", icon: "✓" },
  { route: "evaluation", label: "Evaluation Lab", icon: "⚗" },
];

function routeFromHash(): string {
  // Query parameters (e.g. report?answer=<id>) belong to the screen, not the route.
  return location.hash.replace(/^#\/main\/?/, "").split("?")[0] || "assistant";
}

function SessionPicker() {
  const session = useActiveSession();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const load = () => void api.listSessions().then(setSessions);
  useEffect(load, []);
  useAppEvent((e) => (e.type === "sessions-changed" || e.type === "session-switched") && load());
  if (!session) return null;
  return (
    <div className="col" style={{ padding: "0 8px 10px", gap: 4, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <label className="small faint" htmlFor="session-picker">
        Session
      </label>
      <select
        id="session-picker"
        className="select"
        value={session.id}
        onChange={(e) => {
          if (e.target.value === "__manage") location.hash = "/main/sessions";
          else void api.switchSession(e.target.value);
        }}
      >
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title} · {MODE_LABELS[s.type]}
          </option>
        ))}
        <option value="__manage">Manage sessions…</option>
      </select>
    </div>
  );
}

export function MainWindow() {
  const [settings, update] = useSettings();
  useTheme(settings?.theme);
  const [route, setRoute] = useState(routeFromHash);
  const live = useLiveTranscript();
  const health = useProviderHealth();
  const active = useActiveSession();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteData, setPaletteData] = useState<{ sessions: SessionSummary[]; liveScreen: LiveScreenState | null; latest: string | null }>({ sessions: [], liveScreen: null, latest: null });
  useEffect(() => {
    // ⌘K / Ctrl+K inside Lumen's own window only (not a global shortcut).
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!e.repeat) setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!paletteOpen) return;
    // Fresh state each time the palette opens, so commands match what is true now.
    void Promise.all([
      api.listSessions(),
      api.liveScreenState().catch(() => null),
      api
        .openConversation()
        .then((id) => (id ? api.getMessages(id) : []))
        .then((m) => m.findLast((x) => x.role === "assistant" && !x.meta.cancelled && x.content.trim())?.content ?? null)
        .catch(() => null),
    ]).then(([sessions, liveScreen, latest]) => setPaletteData({ sessions, liveScreen, latest }));
  }, [paletteOpen]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useAppEvent((e) => {
    if (e.type === "navigate") location.hash = e.to;
  });
  const go = (r: string) => {
    location.hash = `/main/${r}`;
  };

  const commands = useMemo(
    () =>
      settings
        ? buildCommands({
            settings,
            sessions: paletteData.sessions,
            activeSessionId: active?.id ?? null,
            live,
            liveScreen: paletteData.liveScreen,
            latestAnswer: paletteData.latest,
            go,
            notify: (m) => showToast(m),
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, paletteData, active?.id, live.status],
  );
  if (!settings) return null;
  if (route === "onboarding") return <OnboardingScreen settings={settings} update={update} onDone={() => go("assistant")} />;

  const recording = isRecordingStatus(live.status);
  const screen = (() => {
    switch (route) {
      case "transcript":
        return <TranscriptScreen settings={settings} live={live} go={go} />;
      case "interview":
        return <InterviewScreen settings={settings} update={update} live={live} go={go} />;
      case "technical":
        return <TechnicalScreen settings={settings} update={update} live={live} />;
      case "history":
        return <HistoryScreen />;
      case "knowledge":
        return <KnowledgeScreen />;
      case "memory":
        return <MemoryScreen settings={settings} update={update} />;
      case "capture":
        return <CaptureScreen settings={settings} update={update} go={go} />;
      case "sessions":
        return <SessionsScreen />;
      case "settings":
        return <SettingsScreen settings={settings} update={update} />;
      case "provider":
        return <ProviderScreen settings={settings} update={update} />;
      case "shortcuts":
        return <ShortcutsScreen settings={settings} update={update} />;
      case "permissions":
        return <PermissionsScreen settings={settings} update={update} />;
      case "privacy":
        return <PrivacyScreen settings={settings} update={update} />;
      case "diagnostics":
        return <DiagnosticsScreen />;
      case "evaluation":
        return <EvaluationScreen />;
      case "quality":
        return <QualityScreen />;
      case "plan":
        return <PlanScreen />;
      case "help":
        return <HelpScreen />;
      case "report":
        return <ReportScreen />;
      default:
        return <AssistantScreen settings={settings} update={update} live={live} />;
    }
  })();

  return (
    <div className="app">
      <nav className={`sidebar ${api.platform === "darwin" ? "mac" : ""}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden /> Lumen
        </div>
        <SessionPicker />
        <nav className="mode-nav" aria-label="Modes">
          {MODES.map((m) => (
            <button key={m.route} className="mode-card" aria-current={route === m.route ? "page" : undefined} onClick={() => go(m.route)}>
              <strong>{m.label}</strong>
              {m.sub}
              {m.route === "transcript" && recording && <span className="dot rec" style={{ marginLeft: 4 }} aria-label="recording" />}
            </button>
          ))}
        </nav>
        {NAV.map((n) => (
          <div key={n.route}>
            {n.section && <div className="nav-section">{n.section}</div>}
            <button className="nav-item" aria-current={route === n.route ? "page" : undefined} aria-label={n.label} title={n.label} onClick={() => go(n.route)}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </button>
          </div>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => setPaletteOpen(true)} title="Command palette" aria-keyshortcuts={api.platform === "darwin" ? "Meta+K" : "Control+K"}>
          <span aria-hidden>⌘</span> Commands <kbd style={{ marginLeft: "auto" }}>{api.platform === "darwin" ? "⌘K" : "Ctrl+K"}</kbd>
        </button>
        <div className="col" style={{ padding: 8, gap: 6, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {recording && <RecordingControls live={live} />}
          <ProviderStatus health={health} />
          {settings.provider.kind === "mock" && <div className="alert warning small">Development mode: answers are mock responses, not AI.</div>}
        </div>
      </nav>
      <main className="content">{screen}</main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <Toasts />
    </div>
  );
}
