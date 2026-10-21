import { useEffect, useState } from "react";
import type { OsPermission, PermissionStatus, Settings } from "../../shared/types";
import { api } from "../lib/api";
import { Switch } from "../components/ui";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

const OS_LABEL: Record<OsPermission, { text: string; cls: string }> = {
  granted: { text: "OS: allowed", cls: "success" },
  denied: { text: "OS: denied", cls: "danger" },
  restricted: { text: "OS: restricted", cls: "danger" },
  "not-determined": { text: "OS: not asked yet", cls: "warning" },
  unknown: { text: "OS: unknown", cls: "" },
  "not-required": { text: "No OS prompt needed", cls: "" },
};

export function usePermissions() {
  const [perm, setPerm] = useState<PermissionStatus | null>(null);
  const refresh = () => void api.permissions().then(setPerm);
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return [perm, refresh, setPerm] as const;
}

export function PermissionList({ settings, update }: Props) {
  const [perm, , setPerm] = usePermissions();
  if (!perm) return null;
  const mac = perm.platform === "darwin";

  return (
    <div>
      <div className="perm-row">
        <div className="grow">
          <strong>Screen context</strong>
          <p>Lets you capture a screen, window or region when you ask, or turn on live screen context explicitly. Lumen never captures in the background. Screen context is never saved to disk and expires after {settings.privacy.screenContextTtlMinutes} minutes unless pinned. Turning this off immediately stops live capture and deletes all screen context.</p>
          {mac && perm.screen !== "granted" && settings.consent.screen && (
            <p className="row">
              <span>macOS requires Screen Recording permission. Enable Lumen in System Settings, then restart Lumen.</span>
              <button className="btn sm" onClick={() => void api.openPermissionSettings("screen")}>
                Open System Settings
              </button>
            </p>
          )}
        </div>
        <span className={`badge ${OS_LABEL[perm.screen].cls}`}>{OS_LABEL[perm.screen].text}</span>
        <Switch label="Screen context" checked={settings.consent.screen} onChange={(v) => void update({ consent: { screen: v } })} />
      </div>
      <div className="perm-row">
        <div className="grow">
          <strong>Microphone</strong>
          <p>Used only while you are recording a live transcript. A red recording indicator is always visible while it is in use. Turning this off stops any recording immediately.</p>
          {perm.microphone === "denied" && (
            <p className="row">
              <span>Microphone access is blocked by the OS.</span>
              <button className="btn sm" onClick={() => void api.openPermissionSettings("microphone")}>
                Open settings
              </button>
            </p>
          )}
        </div>
        <span className={`badge ${OS_LABEL[perm.microphone].cls}`}>{OS_LABEL[perm.microphone].text}</span>
        <Switch
          label="Microphone"
          checked={settings.consent.microphone}
          onChange={(v) =>
            void update({ consent: { microphone: v } }).then(async () => {
              if (v) setPerm(await api.requestMicrophone());
            })
          }
        />
      </div>
      <div className="perm-row">
        <div className="grow">
          <strong>System audio</strong>
          <p>
            {perm.systemAudioSupported
              ? "Separately transcribe audio playing through your speakers (e.g. other meeting participants) as its own channel, labelled “Remote”. Independent of the microphone. Make sure everyone knows the meeting is being transcribed. Also enable “Include system audio” in Settings."
              : "System-audio capture is not supported on this operating system. Use a virtual audio device as the microphone instead."}
          </p>
        </div>
        <Switch label="System audio" disabled={!perm.systemAudioSupported} checked={settings.consent.systemAudio} onChange={(v) => void update({ consent: { systemAudio: v }, transcription: v ? {} : { captureSystemAudio: false } })} />
      </div>
      <div className="perm-row">
        <div className="grow">
          <strong>Clipboard and documents</strong>
          <p>Read only when you click “Clipboard”, press the “ask about selection” shortcut after copying, or choose a file or folder. No permission is needed and nothing is read automatically.</p>
        </div>
        <span className="badge">On demand</span>
      </div>
    </div>
  );
}

export function PermissionsScreen(props: Props) {
  return (
    <>
      <header className="page-header">
        <h1>Permissions</h1>
      </header>
      <div className="page narrow">
        <div className="card">
          <p className="small muted">Each source needs your consent in Lumen and, where the OS requires it, a system permission. Turning a source off immediately stops using it and clears its captured data.</p>
          <PermissionList {...props} />
        </div>
      </div>
    </>
  );
}
