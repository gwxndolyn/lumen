import { useEffect, useState, type KeyboardEvent } from "react";
import type { Settings } from "../../shared/types";
import { api, errMsg, prettyAccelerator } from "../lib/api";
import { toAccelerator } from "../lib/accelerator";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

const LABELS: Record<keyof Settings["shortcuts"], { title: string; hint: string }> = {
  toggleOverlay: { title: "Show / hide assistant", hint: "Open the floating panel and focus the input." },
  askAboutScreen: { title: "Ask about screen", hint: "Capture the display under the cursor and attach it to the next question." },
  askAboutSelection: { title: "Ask about selection", hint: "Copy text in any app (⌘/Ctrl+C), then press this to attach it as selected text." },
  openMainWindow: { title: "Open full window", hint: "Open the main Lumen window." },
};

function Recorder({ value, onSave }: { value: string; onSave: (acc: string) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape") return setRecording(false);
    const acc = toAccelerator(e.nativeEvent, api.platform);
    if (!acc) return;
    setRecording(false);
    onSave(acc).catch((err) => setError(errMsg(err)));
  };
  return (
    <div className="col">
      <button className={`btn ${recording ? "primary" : ""}`} style={{ minWidth: 200, justifyContent: "center" }} onClick={() => setRecording(true)} onKeyDown={onKey} onBlur={() => setRecording(false)} aria-label={recording ? "Press the new shortcut" : `Change shortcut, currently ${value}`}>
        {recording ? "Press keys… (Esc to cancel)" : <kbd>{prettyAccelerator(value)}</kbd>}
      </button>
      {error && <div className="alert error small">{error}</div>}
    </div>
  );
}

export function ShortcutsScreen({ settings, update }: Props) {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const refresh = () => void api.getShortcutStatus().then(setStatus);
  useEffect(refresh, [settings.shortcuts]);

  return (
    <>
      <header className="page-header">
        <h1>Keyboard shortcuts</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void api.resetShortcuts().then(refresh)}>
          Reset to defaults
        </button>
      </header>
      <div className="page narrow">
        <div className="card">
          <h3>Global shortcuts</h3>
          <p className="small muted">These work from any application. If a shortcut is already used by another app, registration fails and is shown below.</p>
          {(Object.keys(LABELS) as (keyof Settings["shortcuts"])[]).map((k) => (
            <div key={k} className="field">
              <div>
                <div className="label">{LABELS[k].title}</div>
                <div className="hint">{LABELS[k].hint}</div>
              </div>
              <div className="row">
                <Recorder value={settings.shortcuts[k]} onSave={(acc) => update({ shortcuts: { [k]: acc } })} />
                {status[k] === false ? <span className="badge danger">Unavailable — in use elsewhere</span> : status[k] ? <span className="badge success">Active</span> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>In the assistant panel</h3>
          <dl className="kv">
            <dt>Send</dt>
            <dd>Enter</dd>
            <dt>New line</dt>
            <dd>Shift+Enter</dd>
            <dt>Stop answer / hide panel</dt>
            <dd>Esc</dd>
            <dt>Stop answer</dt>
            <dd>{prettyAccelerator("CommandOrControl+.")}</dd>
            <dt>New conversation</dt>
            <dd>{prettyAccelerator("CommandOrControl+N")}</dd>
            <dt>Expand / compact</dt>
            <dd>{prettyAccelerator("CommandOrControl+E")}</dd>
          </dl>
        </div>
      </div>
    </>
  );
}
