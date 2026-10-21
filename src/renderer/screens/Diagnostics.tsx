import { useEffect, useState } from "react";
import type { Diagnostics } from "../../shared/types";
import { api, formatTime, usd } from "../lib/api";

const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);

export function DiagnosticsScreen() {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const load = () => void api.diagnostics().then(setD);
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

  const issues: string[] = [];
  if (!d.provider.configured) issues.push("No Anthropic API key — add one in AI provider, or use development mode.");
  if (d.transcription.kind !== "none" && !d.transcription.configured) issues.push("No Deepgram API key — live transcription is unavailable.");
  for (const [k, ok] of Object.entries(d.shortcutsRegistered)) if (!ok) issues.push(`Shortcut “${k}” could not be registered (in use by another app).`);
  if (d.permissions.platform === "darwin" && d.permissions.screen === "denied") issues.push("macOS Screen Recording permission is denied.");
  if (d.permissions.microphone === "denied") issues.push("Microphone access is denied by the OS.");

  // Diagnostics bundle excludes all user content by construction.
  const report = JSON.stringify({ ...d, userDataPath: "<redacted>", dbPath: "<redacted>", logPath: "<redacted>" }, null, 2);

  return (
    <>
      <header className="page-header">
        <h1>Diagnostics</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void api.openLogs()}>
          Open logs folder
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
        <div className="card">
          <h3>Health</h3>
          {issues.length === 0 ? (
            <div className="row">
              <span className="dot ok" /> Everything looks configured.
            </div>
          ) : (
            issues.map((i) => (
              <div key={i} className="row small" style={{ padding: "3px 0" }}>
                <span className="dot warn" /> {i}
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h3>Performance (this session, measured)</h3>
          <div className="stat-grid">
            <div className="stat">
              <div className="v">{ms(d.metrics.p50TtftMs)}</div>
              <div className="l">Time to first token (p50)</div>
            </div>
            <div className="stat">
              <div className="v">{ms(d.metrics.p95TtftMs)}</div>
              <div className="l">Time to first token (p95)</div>
            </div>
            <div className="stat">
              <div className="v">{ms(d.metrics.p50TotalMs)}</div>
              <div className="l">End-to-end latency (p50)</div>
            </div>
            <div className="stat">
              <div className="v">{ms(d.metrics.transcriptionP50LatencyMs)}</div>
              <div className="l">Transcription latency (p50)</div>
            </div>
            <div className="stat">
              <div className="v">{d.metrics.errorRate == null ? "—" : `${Math.round(d.metrics.errorRate * 100)}%`}</div>
              <div className="l">Error rate</div>
            </div>
            <div className="stat">
              <div className="v">{usd(d.metrics.sessionCostUsd)}</div>
              <div className="l">Estimated AI cost</div>
            </div>
            <div className="stat">
              <div className="v">{d.process.memoryMb} MB</div>
              <div className="l">Memory (all processes)</div>
            </div>
            <div className="stat">
              <div className="v">{d.process.cpuPercent}%</div>
              <div className="l">Main-process CPU</div>
            </div>
          </div>
          {d.metrics.requests.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Model</th>
                  <th>Outcome</th>
                  <th>First token</th>
                  <th>Total</th>
                  <th>Tokens in / out</th>
                  <th>Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {d.metrics.requests.map((r, i) => (
                  <tr key={i}>
                    <td>{formatTime(r.at)}</td>
                    <td>{r.model}</td>
                    <td>{r.outcome}</td>
                    <td>{ms(r.ttftMs)}</td>
                    <td>{ms(r.totalMs)}</td>
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
              {d.provider.kind} · {d.provider.model} · {d.provider.configured ? "configured" : "not configured"}
            </dd>
            <dt>Transcription</dt>
            <dd>
              {d.transcription.kind} · {d.transcription.configured ? "configured" : "not configured"}
            </dd>
            <dt>Permissions</dt>
            <dd>
              screen={d.permissions.screen} microphone={d.permissions.microphone} systemAudio={String(d.permissions.systemAudioSupported)}
            </dd>
            <dt>Storage</dt>
            <dd>
              {d.storage.conversations} conversations, {d.storage.messages} messages, {d.storage.transcripts} transcripts, {d.storage.knowledgeDocs} documents
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
