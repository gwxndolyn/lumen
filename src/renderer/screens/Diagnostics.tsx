import { useEffect, useState } from "react";
import type { Diagnostics, LogLevel, ProviderTestResult } from "../../shared/types";
import { describeTest } from "../lib/providerTest";
import { api, errMsg, formatTime, usd } from "../lib/api";
import { Segmented } from "../components/ui";

const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);

const FIX: Record<string, string> = {
  network: "Check your internet connection or the provider base URL.",
  timeout: "The provider was slow; try a faster model or lower effort.",
  rate_limited: "You hit the provider's rate limit; wait a moment.",
  overloaded: "The provider is busy; Lumen retries automatically.",
  auth: "Update the API key in AI provider.",
  missing_credentials: "Add an API key in AI provider.",
  context_too_large: "Remove some attached context.",
  refusal: "The model declined; rephrase the request.",
};

export function DiagnosticsScreen() {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<ProviderTestResult | "running" | null>(null);
  const load = () => void api.diagnostics().then(setD);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  if (!d)
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );

  const issues: { text: string; fix?: string }[] = [];
  if (d.provider.state === "unconfigured") issues.push({ text: "No API key for the selected AI provider.", fix: "Add one in AI provider, or use development mode." });
  if (d.provider.state === "down" || d.provider.state === "degraded") issues.push({ text: `AI provider: ${d.provider.message}` });
  if (d.transcription.kind !== "none" && !d.transcription.configured) issues.push({ text: "No Deepgram API key — live transcription is unavailable." });
  for (const [k, ok] of Object.entries(d.shortcutsRegistered))
    if (!ok) issues.push({ text: `Shortcut “${k}” could not be registered.`, fix: "Another app uses it; pick a different one in Shortcuts." });
  if (d.capture.permission === "denied")
    issues.push({ text: "Screen capture is blocked by the OS.", fix: "Allow Lumen in System Settings → Privacy & Security → Screen Recording, then restart Lumen." });
  if (d.permissions.microphone === "denied") issues.push({ text: "Microphone access is denied by the OS." });
  for (const [code, n] of Object.entries(d.metrics.failuresByCode)) issues.push({ text: `${n} request${n === 1 ? "" : "s"} failed with “${code}” this session.`, fix: FIX[code] });

  // Diagnostics bundle contains metadata only — no prompts, answers, transcripts or images.
  const report = JSON.stringify({ ...d, userDataPath: "<redacted>", dbPath: "<redacted>", logPath: "<redacted>" }, null, 2);

  return (
    <>
      <header className="page-header">
        <h1>Diagnostics</h1>
        <span className="spacer" />
        <button
          className="btn"
          disabled={test === "running"}
          onClick={() => {
            setTest("running");
            void api.testProvider().then((r) => {
              setTest(r);
              load();
            });
          }}
        >
          {test === "running" ? <span className="spinner" /> : null} Test AI provider
        </button>
        <button className="btn" onClick={() => void api.openLogs()}>
          Open logs folder
        </button>
        <button
          className="btn"
          title="Saves versions, health, permission state, timings and recent log lines. No conversations, transcripts, notes, screenshots or keys."
          onClick={() =>
            void api
              .saveSupportBundle()
              .then((p) => p && setNotice({ ok: true, text: `Support file saved to ${p}. Attach it to your bug report.` }))
              .catch((e) => setNotice({ ok: false, text: `Could not save the support file: ${errMsg(e)}` }))
          }
        >
          Save support file
        </button>
        <button
          className="btn"
          onClick={() =>
            void api.copyText(report).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? "Copied" : "Copy report"}
        </button>
      </header>
      <div className="page">
        {notice && (
          <div className={`alert ${notice.ok ? "info" : "error"} small`} role="status" style={{ marginBottom: 12 }}>
            {notice.text}
          </div>
        )}
        {test && test !== "running" && (
          <div className={`alert ${test.ok ? "info" : "error"} small`} style={{ marginBottom: 12 }} role="status">
            <strong>{describeTest(test).title}:</strong> {describeTest(test).detail}
            {describeTest(test).next && <div>{describeTest(test).next}</div>}
          </div>
        )}
        <div className="card">
          <h3>Health</h3>
          {issues.length === 0 ? (
            <div className="row">
              <span className="dot ok" /> Everything looks configured.
            </div>
          ) : (
            issues.map((i) => (
              <div key={i.text} className="row small" style={{ padding: "3px 0", alignItems: "flex-start" }}>
                <span className="dot warn" style={{ marginTop: 5 }} />
                <span>
                  {i.text}
                  {i.fix && <span className="muted"> {i.fix}</span>}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h3>Performance (this app session, measured)</h3>
          <div className="stat-grid">
            <Stat v={ms(d.metrics.p50TtftMs)} l="Time to first token (p50)" />
            <Stat v={ms(d.metrics.p95TtftMs)} l="Time to first token (p95)" />
            <Stat v={ms(d.metrics.p50TotalMs)} l="Total response time (p50)" />
            <Stat v={ms(d.metrics.p50ContextPrepMs)} l="Context preparation (p50)" />
            <Stat v={ms(d.metrics.p50PendingWaitMs)} l="Waiting for OCR (p50)" />
            <Stat v={ms(d.metrics.p50RequestSentMs)} l="Input → request sent (p50)" />
            <Stat v={ms(d.metrics.transcriptionP50LatencyMs)} l="Transcription latency (p50)" />
            <Stat v={ms(d.metrics.ocrP50Ms)} l="OCR time (p50)" />
            <Stat v={ms(d.metrics.captureP50Ms)} l="Screen capture (p50)" />
            <Stat v={ms(d.metrics.cancelP50Ms)} l="Stop → stopped (p50)" />
            <Stat v={d.metrics.errorRate == null ? "—" : `${Math.round(d.metrics.errorRate * 100)}%`} l="Provider error rate" />
            <Stat v={String(d.metrics.totalRetries)} l="Automatic retries" />
            <Stat v={usd(d.metrics.sessionCostUsd)} l="Estimated AI cost" />
            <Stat v={`${d.process.memoryMb} MB`} l="Memory (all processes)" />
            <Stat v={`${d.process.cpuPercent}%`} l="Main-process CPU" />
          </div>
          {d.metrics.requests.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Model</th>
                  <th>Outcome</th>
                  <th>Context prep</th>
                  <th>Sent after</th>
                  <th>First token</th>
                  <th>Total</th>
                  <th>Retries</th>
                  <th>Tokens in / out</th>
                  <th>Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {d.metrics.requests.map((r, i) => (
                  <tr key={i}>
                    <td>{formatTime(r.at)}</td>
                    <td>{r.model}</td>
                    <td>{r.outcome === "error" ? `error (${r.errorCode})` : r.outcome}</td>
                    <td>{ms(r.contextPrepMs)}</td>
                    <td>{ms(r.requestSentMs ?? null)}</td>
                    <td>{ms(r.ttftMs)}</td>
                    <td>{ms(r.totalMs)}</td>
                    <td>{r.retries}</td>
                    <td>
                      {r.inputTokens} / {r.outputTokens}
                    </td>
                    <td>{usd(r.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="small muted">No requests yet this session.</div>
          )}
        </div>

        <div className="card">
          <h3>Platform support — {d.platformProfile.label}</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Status</th>
                <th>How</th>
                <th>Requirement / limitation</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Global shortcuts", d.platformProfile.globalShortcuts],
                  ["Floating panel", d.platformProfile.overlay],
                  ["Screen capture", d.platformProfile.screenCapture],
                  ["Window capture", d.platformProfile.windowCapture],
                  ["Microphone", d.platformProfile.microphone],
                  ["System audio", d.platformProfile.systemAudio],
                  ["Key storage", d.platformProfile.secureStorage],
                  ["Notifications", d.platformProfile.notifications],
                  ["Automatic updates", d.platformProfile.autoUpdate],
                  ["Hidden from screen sharing", d.platformProfile.captureExclusion],
                ] as const
              ).map(([name, c]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{c.supported ? <span className="badge success">Supported</span> : <span className="badge">Not available</span>}</td>
                  <td className="small">{c.via}</td>
                  <td className="small muted">{[c.requirement, c.limitation].filter(Boolean).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Logging</h3>
          <div className="field">
            <div>
              <div className="label">Log level</div>
              <div className="hint">
                Logs contain operational metadata only (timings, error codes). Prompts, answers, transcripts, screenshots and keys are never logged; anything resembling a credential is redacted.
              </div>
            </div>
            <Segmented<LogLevel>
              label="Log level"
              value={d.logLevel}
              options={[
                { value: "off", label: "Off" },
                { value: "error", label: "Errors" },
                { value: "info", label: "Info" },
                { value: "debug", label: "Debug" },
              ]}
              onChange={(v) => void api.updateSettings({ diagnostics: { logLevel: v } }).then(load)}
            />
          </div>
        </div>

        <div className="card">
          <h3>Environment</h3>
          <dl className="kv">
            <dt>Lumen</dt>
            <dd>{d.appVersion}</dd>
            <dt>Electron / Chrome / Node</dt>
            <dd>
              {d.electron} / {d.chrome} / {d.node}
            </dd>
            <dt>Platform</dt>
            <dd>
              {d.platform} {d.arch}
            </dd>
            <dt>AI provider</dt>
            <dd>
              {d.provider.kind} · {d.provider.model} · {d.provider.state}
              {d.provider.checkedAt ? ` (checked ${formatTime(d.provider.checkedAt)})` : ""}
            </dd>
            <dt>Transcription</dt>
            <dd>
              {d.transcription.kind} · {d.transcription.configured ? "configured" : "not configured"}
            </dd>
            <dt>Permissions</dt>
            <dd>
              screen={d.permissions.screen} microphone={d.permissions.microphone} systemAudio={String(d.permissions.systemAudioSupported)}
            </dd>
            <dt>Capture support</dt>
            <dd>
              screens={String(d.capture.screens)} windows={String(d.capture.windows)} live={String(d.capture.liveScreen)} ocr=on-device
            </dd>
            <dt>Storage</dt>
            <dd>
              {d.storage.sessions} sessions, {d.storage.conversations} conversations, {d.storage.messages} messages, {d.storage.transcripts} transcripts, {d.storage.knowledgeDocs} documents,{" "}
              {d.storage.contextItems} saved context items
            </dd>
            <dt>Data folder</dt>
            <dd>{d.userDataPath}</dd>
            <dt>Log file</dt>
            <dd>{d.logPath}</dd>
          </dl>
        </div>
      </div>
    </>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <div className="stat">
      <div className="v">{v}</div>
      <div className="l">{l}</div>
    </div>
  );
}
