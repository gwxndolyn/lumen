import { useState } from "react";
import type { Settings } from "../../shared/types";
import { api, errMsg } from "../lib/api";
import { Switch } from "../components/ui";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

const RETENTION = [
  [1, "1 day"],
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "1 year"],
  [0, "Until I delete it"],
] as const;

export function PrivacyScreen({ settings, update }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  return (
    <>
      <header className="page-header">
        <h1>Privacy & data</h1>
      </header>
      <div className="page narrow">
        <div className="card">
          <h3>Retention</h3>
          <p className="small muted">Older data is deleted automatically at startup and every hour.</p>
          <div className="field">
            <label htmlFor="conv-ret">Conversations</label>
            <select
              id="conv-ret"
              className="select"
              value={settings.privacy.conversationRetentionDays}
              onChange={(e) => void update({ privacy: { conversationRetentionDays: Number(e.target.value) } })}
            >
              {RETENTION.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tr-ret">Transcripts and meeting notes</label>
            <select id="tr-ret" className="select" value={settings.privacy.transcriptRetentionDays} onChange={(e) => void update({ privacy: { transcriptRetentionDays: Number(e.target.value) } })}>
              {RETENTION.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div>
              <label htmlFor="screen-ttl">Screen context lifetime</label>
              <div className="hint">Screenshots and their recognized text are kept in memory only and removed after this long (unless pinned).</div>
            </div>
            <select id="screen-ttl" className="select" value={settings.privacy.screenContextTtlMinutes} onChange={(e) => void update({ privacy: { screenContextTtlMinutes: Number(e.target.value) } })}>
              {[5, 15, 30, 60, 240, 1440].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : m === 1440 ? "1 day" : `${m / 60} hours`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div>
              <div className="label">Mask sensitive data before sending</div>
              <div className="hint">Replaces detected card numbers, API keys, private keys, passwords, SSNs and tokens with “[redacted …]” in everything sent to the AI provider.</div>
            </div>
            <Switch label="Mask sensitive data" checked={settings.privacy.redactSensitive} onChange={(v) => void update({ privacy: { redactSensitive: v } })} />
          </div>
          <div className="field">
            <div className="label">Audio and screenshots</div>
            <div className="small muted">Never written to disk. Audio is streamed to the transcription provider and discarded; screenshots live in memory only.</div>
          </div>
          <div className="field">
            <div className="label">Deletion policy</div>
            <div className="small muted">
              Deleting a session removes its conversations, messages, transcripts, meeting notes, session documents, saved context and the matching full-text index rows. The database uses
              secure-delete, so removed rows are overwritten on disk.
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Where your data lives</h3>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Sessions, conversations, transcripts, notes and knowledge documents: a local SQLite database in your user profile.</li>
            <li>API keys: encrypted with your OS keychain.</li>
            <li>Sent to Anthropic: your question, attached context and retrieved passages, only when you ask.</li>
            <li>Sent to Deepgram: microphone/system audio, only while recording.</li>
            <li>No analytics or telemetry is sent anywhere. Lumen has no server of its own.</li>
            <li>Beta reports and support files are saved only where you choose; they reach the Lumen team only if you send them.</li>
          </ul>
        </div>

        <div className="card">
          <h3>Usage events on this computer</h3>
          <div className="field">
            <div>
              <div className="label">Record usage events</div>
              <div className="hint">
                Request outcomes, error codes, timings, task types, models and setup milestones (first launch, provider test results, onboarding finished, context turned on). Never questions, answers,
                screen text, transcripts or file contents. Used for the Quality screen and, only if you tick it, a beta report. Kept for your conversation retention period. Turning this off stops new
                recording at once; nothing else in Lumen changes.
              </div>
            </div>
            <Switch label="Record usage events" checked={settings.diagnostics.recordUsageEvents} onChange={(v) => void update({ diagnostics: { recordUsageEvents: v } })} />
          </div>
          <div className="row">
            <span className="grow small muted">Delete recorded events, ratings and your test cases now.</span>
            <button
              className="btn"
              onClick={() =>
                void api
                  .clearQuality()
                  .then(() => setStatus("Usage events, ratings and test cases deleted."))
                  .catch((e) => setStatus(`Could not delete: ${errMsg(e)}`))
              }
            >
              Delete usage events
            </button>
          </div>
        </div>

        <div className="card">
          <h3>Session context</h3>
          <div className="row">
            <span className="grow small muted">Remove all attached notes, clipboard text, documents and screenshots from the current session.</span>
            <button className="btn" onClick={() => void api.clearContext().then(() => setStatus("Session context cleared."))}>
              Clear context
            </button>
          </div>
        </div>

        <div className="card">
          <h3>Export</h3>
          <div className="row">
            <span className="grow small muted">Download all conversations, transcripts, meeting notes and knowledge documents as JSON.</span>
            <button
              className="btn"
              onClick={() =>
                void api
                  .exportData()
                  .then((p) => p && setStatus(`Exported to ${p}`))
                  .catch((e) => setStatus(`Export failed: ${errMsg(e)}`))
              }
            >
              Export data
            </button>
          </div>
        </div>

        <div className="card" style={{ borderColor: "color-mix(in srgb, var(--danger) 40%, transparent)" }}>
          <h3>Delete all data</h3>
          <p className="small muted">
            Permanently deletes every conversation, transcript, meeting note and knowledge document, and clears session context. Settings and API keys are kept. Type DELETE to confirm.
          </p>
          <div className="row">
            <input className="input" style={{ maxWidth: 160 }} aria-label="Type DELETE to confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <button
              className="btn danger solid"
              disabled={confirmText !== "DELETE"}
              onClick={() =>
                void api
                  .deleteAllData()
                  .then(() => {
                    setConfirmText("");
                    setStatus("All data deleted.");
                  })
                  .catch((e) => setStatus(`Delete failed: ${errMsg(e)}. Nothing was reported as deleted; try again or check Diagnostics.`))
              }
            >
              Delete everything
            </button>
          </div>
        </div>
        {status && (
          <div className={`alert ${/^(Export failed|Could not|Delet\w* failed)/.test(status) ? "error" : "info"}`} role="status" style={{ marginTop: 12 }}>
            {status}
          </div>
        )}
      </div>
    </>
  );
}
