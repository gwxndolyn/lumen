import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { useAppEvent, useLiveTranscript, useSettings } from "./lib/hooks";
import { Toasts, useTheme } from "./components/ui";
import { AssistantScreen } from "./screens/Assistant";
import { CaptureScreen } from "./screens/Capture";
import { DiagnosticsScreen } from "./screens/Diagnostics";
import { HistoryScreen } from "./screens/History";
import { KnowledgeScreen } from "./screens/Knowledge";
import { OnboardingScreen } from "./screens/Onboarding";
import { PermissionsScreen } from "./screens/Permissions";
import { PrivacyScreen } from "./screens/Privacy";
import { ProviderScreen } from "./screens/Provider";
import { SettingsScreen } from "./screens/Settings";
import { ShortcutsScreen } from "./screens/Shortcuts";
import { TranscriptScreen } from "./screens/Transcript";

const NAV: { section?: string; route: string; label: string; icon: string }[] = [
  { route: "assistant", label: "Assistant", icon: "◎" },
  { route: "transcript", label: "Live transcript", icon: "◉" },
  { route: "history", label: "History", icon: "↺" },
  { route: "knowledge", label: "Knowledge", icon: "✦" },
  { route: "capture", label: "Screen capture", icon: "▣" },
  { section: "Settings", route: "settings", label: "General", icon: "⚙" },
  { route: "provider", label: "AI provider", icon: "⌁" },
  { route: "shortcuts", label: "Shortcuts", icon: "⌘" },
  { route: "permissions", label: "Permissions", icon: "⛉" },
  { route: "privacy", label: "Privacy & data", icon: "◐" },
  { route: "diagnostics", label: "Diagnostics", icon: "≋" },
];

function routeFromHash(): string {
  return location.hash.replace(/^#\/main\/?/, "") || "assistant";
}

export function MainWindow() {
  const [settings, update] = useSettings();
  useTheme(settings?.theme);
  const [route, setRoute] = useState(routeFromHash);
  const live = useLiveTranscript();

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

  if (!settings) return null;
  if (route === "onboarding") return <OnboardingScreen settings={settings} update={update} onDone={() => go("assistant")} />;

  const recording = live.status === "recording" || live.status === "reconnecting" || live.status === "paused";
  const screen = (() => {
    switch (route) {
      case "transcript":
        return <TranscriptScreen settings={settings} live={live} go={go} />;
      case "history":
        return <HistoryScreen />;
      case "knowledge":
        return <KnowledgeScreen />;
      case "capture":
        return <CaptureScreen settings={settings} go={go} />;
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
        {NAV.map((n) => (
          <div key={n.route}>
            {n.section && <div className="nav-section">{n.section}</div>}
            <button className="nav-item" aria-current={route === n.route ? "page" : undefined} onClick={() => go(n.route)}>
              <span aria-hidden>{n.icon}</span> {n.label}
              {n.route === "transcript" && recording && <span className="dot rec" style={{ marginLeft: "auto" }} aria-label="recording" />}
            </button>
          </div>
        ))}
        <div className="spacer" />
        {settings.provider.kind === "mock" && (
          <div className="alert warning small" style={{ margin: 8 }}>
            Development mode: answers are mock responses, not AI.
          </div>
        )}
      </nav>
      <main className="content">{screen}</main>
      <Toasts />
    </div>
  );
}
