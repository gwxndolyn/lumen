import { useEffect, useState } from "react";
import { MODE_LABELS, STYLE_LABELS } from "../../shared/defaults";
import type { Settings } from "../../shared/types";
import { api } from "../lib/api";
import { listMicrophones } from "../lib/audio";
import { Segmented, Switch } from "../components/ui";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

export function SettingsScreen({ settings, update }: Props) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void listMicrophones().then(setMics).catch(() => setMics([]));
  }, [settings.consent.microphone]);
  const s = settings;

  return (
    <>
      <header className="page-header">
        <h1>General</h1>
      </header>
      <div className="page narrow">
        <div className="card">
          <h3>Appearance</h3>
          <div className="field">
            <div className="label">Theme</div>
            <Segmented
              label="Theme"
              value={s.theme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
              onChange={(v) => void update({ theme: v })}
            />
          </div>
        </div>

        <div className="card">
          <h3>Overlay</h3>
          <div className="field">
            <div>
              <label htmlFor="opacity">Opacity</label>
              <div className="hint">{Math.round(s.overlay.opacity * 100)}%</div>
            </div>
            <input id="opacity" type="range" min={0.4} max={1} step={0.02} value={s.overlay.opacity} onChange={(e) => void update({ overlay: { opacity: Number(e.target.value) } })} />
          </div>
          <div className="field">
            <div>
              <div className="label">Always on top</div>
              <div className="hint">Keep the panel above other windows. It stays visible to screen sharing like any normal window.</div>
            </div>
            <Switch label="Always on top" checked={s.overlay.alwaysOnTop} onChange={(v) => void update({ overlay: { alwaysOnTop: v } })} />
          </div>
          <div className="field">
            <div>
              <div className="label">Open on the active display</div>
              <div className="hint">Move the panel to the monitor under the cursor when it opens.</div>
            </div>
            <Switch label="Follow cursor display" checked={s.overlay.followCursorDisplay} onChange={(v) => void update({ overlay: { followCursorDisplay: v } })} />
          </div>
          <div className="field">
            <div>
              <label htmlFor="ov-pos">Position</label>
              <div className="hint">Drag the panel's top bar to move it anywhere; it then remembers that custom spot.</div>
            </div>
            <div className="row">
              <select id="ov-pos" className="select" value={s.overlay.position} onChange={(e) => void update({ overlay: { position: e.target.value } })}>
                <option value="top-center">Top center</option>
                <option value="top-right">Top right</option>
                <option value="bottom-center">Bottom center</option>
                <option value="bottom-right">Bottom right</option>
                <option value="custom">Custom (where I dragged it)</option>
              </select>
              <button className="btn sm" onClick={() => void api.overlay("reset-position")}>
                Reset position
              </button>
            </div>
          </div>
          <div className="field">
            <div>
              <label htmlFor="ov-h">Expanded height</label>
              <div className="hint">{s.overlay.expandedHeight}px — also remembered when you resize the expanded panel.</div>
            </div>
            <input id="ov-h" type="range" min={300} max={1000} step={20} value={s.overlay.expandedHeight} onChange={(e) => void update({ overlay: { expandedHeight: Number(e.target.value) } })} />
          </div>
        </div>

        <div className="card">
          <h3>Assistant defaults</h3>
          <div className="field">
            <label htmlFor="mode">Mode</label>
            <select id="mode" className="select" value={s.assistant.mode} onChange={(e) => void update({ assistant: { mode: e.target.value } })}>
              {Object.entries(MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div>
              <label htmlFor="style">Answer style</label>
              <div className="hint">Default for new questions; change per question in the panel (⌥1–7).</div>
            </div>
            <select id="style" className="select" value={s.assistant.style} onChange={(e) => void update({ assistant: { style: e.target.value } })}>
              {Object.entries(STYLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tone">Tone</label>
            <select id="tone" className="select" value={s.assistant.tone} onChange={(e) => void update({ assistant: { tone: e.target.value } })}>
              <option value="neutral">Neutral</option>
              <option value="friendly">Friendly</option>
              <option value="formal">Formal</option>
              <option value="confident">Confident</option>
            </select>
          </div>
          <div className="field">
            <div>
              <div className="label">Use knowledge base</div>
              <div className="hint">Retrieve relevant passages from your reference documents.</div>
            </div>
            <Switch label="Use knowledge base" checked={s.assistant.useKnowledgeBase} onChange={(v) => void update({ assistant: { useKnowledgeBase: v } })} />
          </div>
          <div className="field">
            <div>
              <div className="label">Use past conversations</div>
              <div className="hint">Retrieve related answers from earlier conversations in the same session.</div>
            </div>
            <Switch label="Use past conversations" checked={s.assistant.useConversationHistory} onChange={(v) => void update({ assistant: { useConversationHistory: v } })} />
          </div>
        </div>

        <div className="card">
          <h3>Transcription</h3>
          <div className="field">
            <label htmlFor="mic">Microphone</label>
            <div>
              <select id="mic" className="select" value={s.transcription.microphoneDeviceId ?? ""} onChange={(e) => void update({ transcription: { microphoneDeviceId: e.target.value || null } })}>
                <option value="">System default</option>
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || `Microphone ${m.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
              {!settings.consent.microphone && <div className="hint">Enable microphone access in Permissions to see device names.</div>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="lang">Language</label>
            <select id="lang" className="select" value={s.transcription.language} onChange={(e) => void update({ transcription: { language: e.target.value } })}>
              {[
                ["en", "English"],
                ["multi", "Multilingual (auto)"],
                ["es", "Spanish"],
                ["fr", "French"],
                ["de", "German"],
                ["ja", "Japanese"],
                ["zh", "Chinese"],
                ["hi", "Hindi"],
                ["pt", "Portuguese"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div>
              <div className="label">Include system audio</div>
              <div className="hint">Also transcribe, as a separate channel, what other participants say through your speakers (Windows, macOS 13+). Requires system-audio permission.</div>
            </div>
            <Switch
              label="Include system audio"
              disabled={!settings.consent.systemAudio}
              checked={s.transcription.captureSystemAudio}
              onChange={(v) => void update({ transcription: { captureSystemAudio: v } })}
            />
          </div>
        </div>
      </div>
    </>
  );
}
