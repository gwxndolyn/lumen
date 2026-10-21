import { useEffect, useState } from "react";
import { MODELS } from "../../shared/defaults";
import type { ProviderTestResult, SecretsStatus, Settings } from "../../shared/types";
import { api, errMsg } from "../lib/api";
import { Segmented } from "../components/ui";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

function KeyField({ name, label, present, onChange, hint }: { name: "anthropic" | "deepgram"; label: string; present: boolean; onChange: (s: SecretsStatus) => void; hint: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="field">
      <div>
        <div className="label">{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <div className="col">
        <div className="row">
          <span className={`dot ${present ? "ok" : ""}`} />
          <span className="small">{present ? "Key stored" : "Not configured"}</span>
          {present && (
            <button className="btn ghost sm danger" onClick={() => void api.clearSecret(name).then(onChange)}>
              Remove
            </button>
          )}
        </div>
        <div className="row">
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label} API key`}
            placeholder={present ? "Replace key…" : "Paste API key"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!value.trim()}
            onClick={() =>
              void api
                .setSecret(name, value)
                .then((s) => {
                  setValue("");
                  setError(null);
                  onChange(s);
                })
                .catch((e) => setError(errMsg(e)))
            }
          >
            Save
          </button>
        </div>
        {error && <div className="alert error small">{error}</div>}
      </div>
    </div>
  );
}

export function ProviderScreen({ settings, update }: Props) {
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [test, setTest] = useState<ProviderTestResult | "running" | null>(null);
  useEffect(() => void api.secretsStatus().then(setSecrets), []);
  const p = settings.provider;

  return (
    <>
      <header className="page-header">
        <h1>AI provider</h1>
      </header>
      <div className="page narrow">
        {secrets && !secrets.encryptionAvailable && (
          <div className="alert warning" style={{ marginBottom: 12 }}>
            OS-level encryption is not available on this system, so API keys are kept in memory only and must be re-entered after restarting Lumen.
          </div>
        )}
        <div className="card">
          <h3>Language model</h3>
          <div className="field">
            <div>
              <div className="label">Provider</div>
              <div className="hint">Development mode returns clearly labelled mock responses without contacting any AI service.</div>
            </div>
            <Segmented
              label="Provider"
              value={p.kind}
              options={[
                { value: "anthropic", label: "Anthropic Claude" },
                { value: "mock", label: "Development mode" },
              ]}
              onChange={(v) => void update({ provider: { kind: v } })}
            />
          </div>
          {secrets && (
            <KeyField
              name="anthropic"
              label="Anthropic API key"
              present={secrets.anthropic}
              onChange={setSecrets}
              hint="Stored encrypted with your OS keychain and only used by the app's main process. Create one at console.anthropic.com."
            />
          )}
          <div className="field">
            <label htmlFor="model">Model</label>
            <div className="col">
              <select id="model" className="select" value={p.model} onChange={(e) => void update({ provider: { model: e.target.value } })}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {m.note}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <div>
              <div className="label">Effort</div>
              <div className="hint">Lower is faster and cheaper; higher reasons more deeply before answering.</div>
            </div>
            <Segmented
              label="Effort"
              value={p.effort}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
              onChange={(v) => void update({ provider: { effort: v } })}
            />
          </div>
          <div className="field">
            <div>
              <label htmlFor="maxTokens">Max output tokens</label>
              <div className="hint">Upper bound per answer.</div>
            </div>
            <input id="maxTokens" className="input" type="number" min={256} max={64000} step={256} value={p.maxTokens} onChange={(e) => void update({ provider: { maxTokens: Number(e.target.value) } }).catch(() => undefined)} />
          </div>
          <div className="field">
            <div>
              <label htmlFor="timeout">Request timeout (seconds)</label>
            </div>
            <input id="timeout" className="input" type="number" min={5} max={600} value={Math.round(p.timeoutMs / 1000)} onChange={(e) => void update({ provider: { timeoutMs: Number(e.target.value) * 1000 } }).catch(() => undefined)} />
          </div>
          <div className="field">
            <div className="label">Connection</div>
            <div className="col">
              <div>
                <button
                  className="btn"
                  disabled={test === "running"}
                  onClick={() => {
                    setTest("running");
                    void api.testProvider().then(setTest);
                  }}
                >
                  {test === "running" ? <span className="spinner" /> : null} Test connection
                </button>
              </div>
              {test && test !== "running" && (
                <div className={`alert ${test.ok ? "info" : "error"} small`}>
                  {test.message}
                  {test.latencyMs != null && ` (${test.latencyMs} ms)`}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Speech-to-text</h3>
          <div className="field">
            <div className="label">Provider</div>
            <Segmented
              label="Transcription provider"
              value={settings.transcription.kind}
              options={[
                { value: "deepgram", label: "Deepgram (streaming)" },
                { value: "none", label: "Off" },
              ]}
              onChange={(v) => void update({ transcription: { kind: v } })}
            />
          </div>
          {secrets && (
            <KeyField
              name="deepgram"
              label="Deepgram API key"
              present={secrets.deepgram}
              onChange={setSecrets}
              hint="Used for live meeting transcription. Audio is streamed to Deepgram over TLS and is not stored by Lumen."
            />
          )}
        </div>

        <div className="card">
          <h3>Data handling</h3>
          <p className="small muted">
            When you ask a question, Lumen sends your question, the context sources you attached and relevant retrieved passages to api.anthropic.com over HTTPS. During a live transcript, microphone audio streams to api.deepgram.com. No other network destinations are contacted, and Lumen has no telemetry. See each provider's data-retention policy for how they handle API data.
          </p>
        </div>
      </div>
    </>
  );
}
