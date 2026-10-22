import { useEffect, useState, type KeyboardEvent } from "react";
import type { Settings } from "../../shared/types";
import { api, errMsg, prettyAccelerator } from "../lib/api";
import { toAccelerator } from "../lib/accelerator";
import { useAppEvent } from "../lib/hooks";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

const LABELS: Record<keyof Settings["shortcuts"], { title: string; hint: string; group: "Assistant" | "Panel" | "Context" }> = {
  requestAssist: { group: "Assistant", title: "Get AI help", hint: "Sends what you typed; if the input is empty, asks about the context you have authorized (captures the screen only when screen context is on)." },
  toggleOverlay: { group: "Assistant", title: "Show / hide assistant", hint: "Hiding never stops an answer that is being written. Showing does not take focus from your current app." },
  discreetInput: { group: "Assistant", title: "Discreet input", hint: "A slim one-line input bar. Press again or Esc to return to the full panel." },
  scrollUp: { group: "Panel", title: "Scroll answer up", hint: "Scrolls Lumen's answer, not the app underneath. Only active while the panel is visible." },
  scrollDown: { group: "Panel", title: "Scroll answer down", hint: "Only active while the panel is visible, so the keys keep working normally elsewhere." },
  moveLeft: { group: "Panel", title: "Move panel left", hint: "Moves the panel within its display. Only active while the panel is visible." },
  moveRight: { group: "Panel", title: "Move panel right", hint: "Only active while the panel is visible." },
  askAboutScreen: { group: "Context", title: "Attach screen", hint: "Capture the display under the cursor and attach it to the next question." },
  askAboutSelection: { group: "Context", title: "Attach selection", hint: "Copy text in any app (⌘/Ctrl+C), then press this to attach it as selected text." },
  openMainWindow: { group: "Context", title: "Open full window", hint: "Open the main Lumen window." },
};

type Status = Record<string, { status: string; accelerator: string; reason?: string; alternatives?: string[] }>;

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
  const [status, setStatus] = useState<Status>({});
  const refresh = () => void api.getShortcutStatus().then(setStatus);
  useEffect(refresh, [settings.shortcuts]);
  useAppEvent((e) => e.type === "shortcut-status" && setStatus(e.status));

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
        {(["Assistant", "Panel", "Context"] as const).map((group) => (
          <div className="card" key={group}>
            <h3>{group === "Assistant" ? "Global shortcuts" : group === "Panel" ? "Panel navigation" : "Context & windows"}</h3>
            {group === "Assistant" && (
              <p className="small muted">These work while other apps are focused. Lumen only receives the exact combinations below — ordinary typing is never intercepted.</p>
            )}
            {(Object.keys(LABELS) as (keyof Settings["shortcuts"])[])
              .filter((k) => LABELS[k].group === group)
              .map((k) => {
                const st = status[k];
                return (
                  <div key={k} className="field shortcut-row">
                    <div>
                      <div className="label">{LABELS[k].title}</div>
                      <div className="hint">{LABELS[k].hint}</div>
                    </div>
                    <div className="col">
                      <div className="row">
                        <Recorder value={settings.shortcuts[k]} onSave={(acc) => update({ shortcuts: { [k]: acc } })} />
                        {settings.shortcuts[k] && (
                          <button className="btn ghost sm" title="Disable this shortcut" onClick={() => void update({ shortcuts: { [k]: "" } })}>
                            Disable
                          </button>
                        )}
                        {st?.status === "active" && <span className="badge success">Active</span>}
                        {st?.status === "inactive" && <span className="badge" title={st.reason}>When panel visible</span>}
                        {st?.status === "disabled" && <span className="badge">Off</span>}
                        {(st?.status === "conflict" || st?.status === "duplicate" || st?.status === "invalid") && <span className="badge danger">Unavailable</span>}
                      </div>
                      {st && st.status !== "active" && st.status !== "inactive" && st.status !== "disabled" && (
                        <div className="alert warning small">
                          {st.reason}
                          {st.alternatives?.length ? (
                            <span className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
                              Try:
                              {st.alternatives.map((alt) => (
                                <button key={alt} className="btn sm" onClick={() => void update({ shortcuts: { [k]: alt } })}>
                                  <kbd>{prettyAccelerator(alt)}</kbd>
                                </button>
                              ))}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        ))}
        <div className="card">
          <h3>In the assistant panel</h3>
          <dl className="kv">
            <dt>Send</dt>
            <dd>Enter</dd>
            <dt>Ask with current context</dt>
            <dd>{prettyAccelerator("CommandOrControl+Enter")}</dd>
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
