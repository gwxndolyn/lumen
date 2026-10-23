import { useEffect, useState } from "react";
import { MODELS, PROVIDER_INFO } from "../../shared/defaults";
import type { ProviderTestResult, SecretName, SecretsStatus, Settings } from "../../shared/types";
import { describeTest } from "../lib/providerTest";
import { api, errMsg, formatTime, usd } from "../lib/api";
import { useProviderHealth } from "../lib/hooks";
import { ProviderStatus, Segmented, Switch } from "../components/ui";
import { HybridSettings } from "./HybridSettings";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };

function KeyField({ name, label, present, onChange, hint, optional }: { name: SecretName; label: string; present: boolean; onChange: (s: SecretsStatus) => void; hint: string; optional?: boolean }) {
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
          <span className={`dot ${present ? "ok" : optional ? "" : "err"}`} />
          <span className="small">{present ? "Key stored (encrypted)" : optional ? "Not set (optional)" : "Not configured"}</span>
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

/** Text/number input that validates and saves on blur or Enter, not on every keystroke. */
function CommitField({
  id,
  value,
  onCommit,
  type = "text",
  min,
  max,
  suffix,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => Promise<void>;
  type?: "text" | "number";
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    if (draft === value) return;
    if (type === "number") {
      const n = Number(draft);
      if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
        setError(`Enter a number between ${min} and ${max}.`);
        return;
      }
    }
    try {
      await onCommit(draft);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row">
        <input
          id={id}
          className="input"
          type={type}
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
        />
        {suffix && <span className="small muted">{suffix}</span>}
      </div>
      {error && <div className="alert error small">{error}</div>}
    </div>
  );
}

export function ProviderScreen({ settings, update }: Props) {
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [test, setTest] = useState<ProviderTestResult | "running" | null>(null);
  const health = useProviderHealth();
  const [devMode, setDevMode] = useState(false);
  const [spend, setSpend] = useState<{ costUsd: number; requests: number } | null>(null);
  useEffect(() => {
    void api.secretsStatus().then(setSecrets);
    void api.appInfo().then((i) => setDevMode(i.devModeAllowed));
    void api.spendToday().then(setSpend);
  }, []);
  const p = settings.provider;
  const runTest = () => {
    setTest("running");
    void api.testProvider().then(setTest);
  };

  return (
    <>
      <header className="page-header">
        <h1>AI provider</h1>
        <ProviderStatus health={health} />
        <span className="spacer" />
        <button className="btn" disabled={test === "running"} onClick={runTest}>
          {test === "running" ? <span className="spinner" /> : null} Test connection
        </button>
      </header>
      <div className="page narrow">
        {secrets && !secrets.encryptionAvailable && (
          <div className="alert warning" style={{ marginBottom: 12 }}>
            OS-level encryption is not available on this system, so API keys are kept in memory only and must be re-entered after restarting Lumen.
          </div>
        )}
        {secrets && secrets.unreadable.length > 0 && (
          <div className="alert warning small" style={{ marginBottom: 12 }}>
            Some saved keys could not be decrypted ({secrets.unreadable.join(", ")}). This happens if the OS keychain was reset or your profile was copied from another computer. Enter them again
            below.
          </div>
        )}
        {test && test !== "running" && (
          <div className={`alert ${test.ok ? "info" : "error"} small`} style={{ marginBottom: 12 }} role="status">
            <strong>{describeTest(test).title}:</strong> {describeTest(test).detail}
            {describeTest(test).next && <div>{describeTest(test).next}</div>}
          </div>
        )}
        {health && health.checkedAt && (
          <div className="small faint" style={{ marginBottom: 12 }}>
            Last result: {health.message} — {formatTime(health.checkedAt)}
          </div>
        )}
        <div className="card">
          <h3>Language model</h3>
          <div className="field">
            <div>
              <div className="label">Provider</div>
              <div className="hint">Development mode returns clearly labelled mock responses without contacting any AI service.</div>
            </div>
            <select className="select" aria-label="Provider" value={p.kind} onChange={(e) => void update({ provider: { kind: e.target.value } })}>
              <option value="anthropic">Anthropic Claude</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai_compat">Custom (OpenAI-compatible)</option>
              <option value="ollama">Local model (Ollama, on this computer)</option>
              {(devMode || p.kind === "mock") && <option value="mock">Development mode (no AI)</option>}
            </select>
          </div>
          {p.kind === "anthropic" && secrets && (
            <>
              <KeyField
                name="anthropic"
                label="Anthropic API key"
                present={secrets.anthropic}
                onChange={setSecrets}
                hint="Stored encrypted with your OS keychain and only used by the app's main process. Create one at console.anthropic.com."
              />
              <div className="field">
                <label htmlFor="model">Model</label>
                <select id="model" className="select" value={p.model} onChange={(e) => void update({ provider: { model: e.target.value } })}>
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </select>
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
            </>
          )}
          {(p.kind === "openai" || p.kind === "gemini") && secrets && (
            <>
              <KeyField
                name={p.kind}
                label={`${PROVIDER_INFO[p.kind].label} API key`}
                present={secrets[p.kind]}
                onChange={setSecrets}
                hint={`Stored encrypted with your OS credential store and only sent to ${PROVIDER_INFO[p.kind].host}. Create one at ${PROVIDER_INFO[p.kind].keyUrl.replace("https://", "")}.`}
              />
              <div className="field">
                <div>
                  <label htmlFor="pmodel">Model</label>
                  <div className="hint">Pick a preset or type any model id your account can use. Use “Test connection” to confirm it is available.</div>
                </div>
                <div className="col">
                  <CommitField id="pmodel" value={p[p.kind].model} onCommit={(v) => update({ provider: { [p.kind]: { model: v.trim() } } })} />
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {PROVIDER_INFO[p.kind].models.map((m) => (
                      <button key={m} className={`btn sm ${p[p.kind as "openai" | "gemini"].model === m ? "primary" : ""}`} onClick={() => void update({ provider: { [p.kind]: { model: m } } })}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
          {p.kind === "openai_compat" && secrets && (
            <>
              <div className="field">
                <div>
                  <label htmlFor="oc-url">Base URL</label>
                  <div className="hint">Any server implementing the OpenAI-compatible /chat/completions streaming API, e.g. Ollama (http://localhost:11434/v1), LM Studio or vLLM.</div>
                </div>
                <CommitField id="oc-url" value={p.openaiCompat.baseUrl} onCommit={(v) => update({ provider: { openaiCompat: { baseUrl: v.trim() } } })} />
              </div>
              <div className="field">
                <label htmlFor="oc-model">Model</label>
                <CommitField id="oc-model" value={p.openaiCompat.model} onCommit={(v) => update({ provider: { openaiCompat: { model: v.trim() } } })} />
              </div>
              <KeyField name="openai_compat" label="API key" optional present={secrets.openai_compat} onChange={setSecrets} hint="Only needed for hosted servers. Sent only to the base URL above." />
              <div className="field">
                <div>
                  <div className="label">Model accepts images</div>
                  <div className="hint">Turn on only for vision models (e.g. llava, qwen-vl). When off, screen captures contribute their recognized (OCR) text only.</div>
                </div>
                <Switch label="Model accepts images" checked={p.openaiCompat.supportsImages} onChange={(v) => void update({ provider: { openaiCompat: { supportsImages: v } } })} />
              </div>
            </>
          )}
          {p.kind === "ollama" && <p className="small muted">Choose the installed model under “Local model (Ollama)” below. Nothing leaves this computer.</p>}
          {p.kind !== "mock" && (
            <>
              <div className="field">
                <div>
                  <label htmlFor="spend">Daily spend limit</label>
                  <div className="hint">
                    Estimated from token usage (Anthropic, OpenAI and Gemini list prices where known). 0 = no limit. Today: {spend ? usd(spend.costUsd) : "—"} across {spend?.requests ?? 0} requests.
                  </div>
                </div>
                <CommitField
                  id="spend"
                  type="number"
                  min={0}
                  max={10000}
                  suffix="USD / day"
                  value={String(p.dailySpendLimitUsd)}
                  onCommit={(v) => update({ provider: { dailySpendLimitUsd: Number(v) } })}
                />
              </div>
              {p.kind === "anthropic" && (
                <div className="field">
                  <div>
                    <div className="label">Economy routing</div>
                    <div className="hint">
                      For quick general questions, use a cheaper Claude model than the one selected above. Stays with Anthropic: Lumen never switches to a different provider. Coding, debugging, design
                      and deep answers always use your selected model. Answers show “(economy)” when this applies.
                    </div>
                  </div>
                  <Segmented
                    label="Economy routing"
                    value={p.routing}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "economy", label: "Economy" },
                    ]}
                    onChange={(v) => void update({ provider: { routing: v } })}
                  />
                </div>
              )}
              {p.kind !== "anthropic" && (
                <div className="field">
                  <div>
                    <div className="label">Price for this model</div>
                    <div className="hint">
                      Lumen only ships Anthropic prices. Enter your provider's current USD price per million tokens so cost estimates and the spend limit work; leave empty for “unknown”.
                    </div>
                  </div>
                  <div className="row">
                    <CommitField
                      id="pin"
                      type="number"
                      min={0}
                      max={1000}
                      suffix="in"
                      value={p.customPrice ? String(p.customPrice.input) : ""}
                      onCommit={(v) => update({ provider: { customPrice: v === "" ? null : { input: Number(v), output: p.customPrice?.output ?? 0 } } })}
                    />
                    <CommitField
                      id="pout"
                      type="number"
                      min={0}
                      max={1000}
                      suffix="out"
                      value={p.customPrice ? String(p.customPrice.output) : ""}
                      onCommit={(v) => update({ provider: { customPrice: v === "" ? null : { input: p.customPrice?.input ?? 0, output: Number(v) } } })}
                    />
                  </div>
                </div>
              )}
              <div className="field">
                <div>
                  <label htmlFor="maxTokens">Max output tokens</label>
                  <div className="hint">Upper bound per answer (256–64,000).</div>
                </div>
                <CommitField id="maxTokens" type="number" min={256} max={64000} value={String(p.maxTokens)} onCommit={(v) => update({ provider: { maxTokens: Math.round(Number(v)) } })} />
              </div>
              <div className="field">
                <div>
                  <label htmlFor="timeout">Request timeout</label>
                  <div className="hint">Maximum time for one answer.</div>
                </div>
                <CommitField
                  id="timeout"
                  type="number"
                  min={5}
                  max={600}
                  suffix="seconds"
                  value={String(Math.round(p.timeoutMs / 1000))}
                  onCommit={(v) => update({ provider: { timeoutMs: Math.round(Number(v)) * 1000 } })}
                />
              </div>
              <div className="field">
                <div>
                  <label htmlFor="idle">Stall timeout</label>
                  <div className="hint">If the stream goes silent this long, Lumen aborts it and retries (only if nothing was shown yet).</div>
                </div>
                <CommitField
                  id="idle"
                  type="number"
                  min={5}
                  max={300}
                  suffix="seconds"
                  value={String(Math.round(p.idleTimeoutMs / 1000))}
                  onCommit={(v) => update({ provider: { idleTimeoutMs: Math.round(Number(v)) * 1000 } })}
                />
              </div>
            </>
          )}
        </div>

        <HybridSettings settings={settings} update={update} />

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
          {secrets && settings.transcription.kind === "deepgram" && (
            <KeyField
              name="deepgram"
              label="Deepgram API key"
              present={secrets.deepgram}
              onChange={setSecrets}
              hint="Used for live transcription. Audio is streamed to Deepgram over TLS and is not stored by Lumen."
            />
          )}
          <div className="field">
            <div>
              <div className="label">Save transcripts</div>
              <div className="hint">When off, transcripts exist only in memory while recording and are discarded when you stop.</div>
            </div>
            <Switch label="Save transcripts" checked={settings.transcription.persist} onChange={(v) => void update({ transcription: { persist: v } })} />
          </div>
        </div>

        <div className="card">
          <h3>Data handling</h3>
          <p className="small muted">
            When you ask a question, Lumen sends your question, the context you attached to the active session and the most relevant retrieved passages to the selected provider (
            {p.kind === "anthropic"
              ? "api.anthropic.com"
              : p.kind === "openai_compat"
                ? safeHost(p.openaiCompat.baseUrl)
                : p.kind === "ollama"
                  ? "the local model on this computer — nothing leaves it"
                  : p.kind === "mock"
                    ? "nowhere — development mode"
                    : PROVIDER_INFO[p.kind].host}
            ){settings.inference.mode !== "manual" ? ", or to the local model when hybrid routing chooses it (each answer shows where it ran)" : ""}
            {settings.inference.privacyRestricted ? ". Privacy restriction keeps screen content, transcripts and documents on this device unless you allowed them" : ""}. During a live transcript,
            audio streams to api.deepgram.com. {settings.privacy.redactSensitive ? "Detected secrets (card numbers, API keys, passwords) are masked first. " : ""}Lumen has no telemetry.
          </p>
        </div>
      </div>
    </>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
