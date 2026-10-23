import { useEffect, useMemo, useState } from "react";
import type { EvalCatalog, EvalEstimate, EvalRun, EvalStartRequest, RunComparison, RunListItem } from "../../shared/api";
import { api, errMsg, formatTime, usd } from "../lib/api";
import { Empty, Segmented } from "../components/ui";

type Tab = "run" | "results" | "compare" | "cases";
type CaseStatus = EvalRun["results"][number]["status"] | "not_run";

const STATUS_LABEL: Record<CaseStatus, string> = { not_run: "Not yet evaluated", running: "Running", passed: "Passed", failed: "Failed", skipped: "Skipped", inconclusive: "Inconclusive" };
const STATUS_BADGE: Record<CaseStatus, string> = { not_run: "", running: "accent", passed: "success", failed: "danger", skipped: "", inconclusive: "warning" };
const RUN_BADGE: Record<EvalRun["status"], string> = { running: "accent", complete: "success", partial: "warning", cancelled: "warning", failed: "danger" };
const VERDICT_BADGE = { improved: "success", regressed: "danger", unchanged: "", inconclusive: "warning" } as const;
const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);

function StatusBadge({ s }: { s: CaseStatus }) {
  return <span className={`badge ${STATUS_BADGE[s]}`}>{STATUS_LABEL[s]}</span>;
}

function Counts({ c }: { c: RunListItem["counts"] }) {
  return (
    <span className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
      <span className="badge success">{c.passed} passed</span>
      <span className="badge danger">{c.failed} failed</span>
      {c.inconclusive > 0 && <span className="badge warning">{c.inconclusive} inconclusive</span>}
      {c.skipped > 0 && <span className="badge">{c.skipped} skipped</span>}
      {c.not_run > 0 && <span className="badge">{c.not_run} not run</span>}
    </span>
  );
}

export function EvaluationScreen() {
  const [catalog, setCatalog] = useState<EvalCatalog | null>(null);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [live, setLive] = useState<EvalRun | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>("run");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRuns = () =>
    void api
      .evalList()
      .then(setRuns)
      .catch((e) => setError(errMsg(e)));
  useEffect(() => {
    void api.evalCatalog().then(setCatalog, (e) => setError(errMsg(e)));
    void api.evalStatus().then((s) => setRunning(s.running));
    loadRuns();
    return api.onEval((e) => {
      if (e.type === "progress") {
        setLive(e.run);
        setRunning(e.run.status === "running");
      } else {
        setRunning(false);
        if (e.error) setError(e.error);
        else if (e.runIds.length) {
          setSelected(e.runIds.at(-1)!);
          setTab("results");
        }
        loadRuns();
      }
    });
  }, []);

  if (!catalog) return null;
  return (
    <>
      <header className="page-header">
        <h1>Evaluation Lab</h1>
        <span className="muted small">
          Benchmark v{catalog.benchmarkVersion} · {catalog.cases.length} synthetic cases. Results come only from runs you start here.
        </span>
        <span style={{ flex: 1 }} />
        <Segmented<Tab>
          label="Evaluation view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "run", label: "Run" },
            { value: "results", label: "Results" },
            { value: "compare", label: "Compare" },
            { value: "cases", label: "Cases" },
          ]}
        />
      </header>
      <div className="page">
        {error && (
          <div className="alert error small" role="alert" style={{ marginBottom: 12 }}>
            {error}{" "}
            <button className="btn sm ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {notice && (
          <div className="alert info small" role="status" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}
        {running && live && <Progress run={live} />}
        {tab === "run" && <RunPanel catalog={catalog} running={running} onError={setError} onStarted={() => (setError(null), setRunning(true), setLive(null))} />}
        {tab === "results" && (
          <ResultsPanel catalog={catalog} runs={runs} selected={selected} onSelect={setSelected} onChanged={loadRuns} onError={setError} onNotice={setNotice} liveRun={running ? live : null} />
        )}
        {tab === "compare" && <ComparePanel runs={runs} onError={setError} />}
        {tab === "cases" && <CasesPanel catalog={catalog} />}
      </div>
    </>
  );
}

function Progress({ run }: { run: EvalRun }) {
  const total = run.caseIds.length * run.config.repeat;
  const doneN = run.results.length;
  return (
    <div className="card" role="status" aria-live="polite">
      <div className="row">
        <strong>
          Running {run.config.mode} evaluation{run.config.label ? ` · ${run.config.label}` : ""}
        </strong>
        <span className="muted small">
          {doneN} / {total} cases
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn danger" onClick={() => void api.evalStop()}>
          Stop
        </button>
      </div>
      <progress value={doneN} max={total} style={{ width: "100%", marginTop: 8 }} aria-label="Evaluation progress" />
      <div style={{ marginTop: 6 }}>
        <Counts c={run.summary.counts} />
      </div>
    </div>
  );
}

function RunPanel({ catalog, running, onStarted, onError }: { catalog: EvalCatalog; running: boolean; onStarted: () => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<"deterministic" | "live">("deterministic");
  const [cats, setCats] = useState<string[]>([]);
  const [repeat, setRepeat] = useState(1);
  const [maxCost, setMaxCost] = useState(catalog.defaultLimits.maxCostUsd);
  const [concurrency, setConcurrency] = useState(catalog.defaultLimits.concurrency);
  const [maxOut, setMaxOut] = useState(catalog.defaultLimits.maxOutputTokens);
  const [maxCases, setMaxCases] = useState(catalog.defaultLimits.maxCases);
  const [kind, setKind] = useState<"single" | "experiment">("single");
  const [preset, setPreset] = useState(0);
  const [estimate, setEstimate] = useState<EvalEstimate | null>(null);
  const [confirm, setConfirm] = useState(false);

  const req = (): EvalStartRequest => ({
    mode,
    categories: cats.length ? cats : undefined,
    repeat,
    limits: { maxCostUsd: maxCost, concurrency, maxOutputTokens: maxOut, maxCases },
    experiment: kind === "experiment" ? catalog.presets[preset] : undefined,
    confirmLive: mode === "live" ? confirm : undefined,
  });
  useEffect(() => {
    setConfirm(false);
    if (mode !== "live") return setEstimate(null);
    void api.evalEstimate(req()).then(setEstimate, (e) => onError(errMsg(e)));
  }, [mode, cats.join(","), repeat, maxOut, kind, preset]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCount = catalog.cases.filter((c) => !cats.length || cats.includes(c.category)).length;
  const toggle = (c: string) => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const start = () =>
    void api
      .evalStart(req())
      .then(onStarted)
      .catch((e) => onError(errMsg(e)));

  return (
    <>
      <div className="card">
        <h3>What to run</h3>
        <div className="field">
          <div>
            <div className="label">Mode</div>
            <div className="hint">
              Deterministic runs the real request pipeline against a scripted provider: no network, no key, reproducible. It measures how Lumen builds requests and handles failures, not answer
              quality. Live calls your configured AI provider and checks real answers.
            </div>
          </div>
          <Segmented<"deterministic" | "live">
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "deterministic", label: "Deterministic" },
              { value: "live", label: "Live model" },
            ]}
          />
        </div>
        <div className="field">
          <div>
            <div className="label">Categories</div>
            <div className="hint">None selected = all. {selectedCount} cases selected.</div>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {Object.entries(catalog.categories).map(([k, label]) => (
              <button key={k} className={`btn sm ${cats.includes(k) ? "primary" : ""}`} aria-pressed={cats.includes(k)} onClick={() => toggle(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <div>
            <div className="label">Run type</div>
            <div className="hint">An experiment runs the same cases once per variant and compares each variant with the first. It never changes Lumen's settings.</div>
          </div>
          <div className="col">
            <Segmented<"single" | "experiment">
              label="Run type"
              value={kind}
              onChange={setKind}
              options={[
                { value: "single", label: "Single run" },
                { value: "experiment", label: "Experiment" },
              ]}
            />
            {kind === "experiment" && (
              <select className="select" aria-label="Experiment" value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
                {catalog.presets.map((p, i) => (
                  <option key={p.name} value={i}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="field">
          <div>
            <div className="label">Repeats</div>
            <div className="hint">Live answers vary. Use 3+ repeats before trusting a difference.</div>
          </div>
          <input
            className="input"
            style={{ width: 90 }}
            type="number"
            min={1}
            max={5}
            aria-label="Repeats"
            value={repeat}
            onChange={(e) => setRepeat(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
          />
        </div>
      </div>

      {mode === "live" && (
        <div className="card">
          <h3>Limits</h3>
          <div className="field">
            <div className="label">Maximum estimated cost (USD)</div>
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              min={0}
              max={catalog.hardLimits.maxCostUsd}
              step={0.1}
              aria-label="Maximum cost"
              value={maxCost}
              onChange={(e) => setMaxCost(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div className="field">
            <div className="label">Concurrency</div>
            <input
              className="input"
              style={{ width: 90 }}
              type="number"
              min={1}
              max={catalog.hardLimits.concurrency}
              aria-label="Concurrency"
              value={concurrency}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(catalog.hardLimits.concurrency, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="field">
            <div className="label">Max output tokens per case</div>
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              min={64}
              max={catalog.hardLimits.maxOutputTokens}
              aria-label="Max output tokens"
              value={maxOut}
              onChange={(e) => setMaxOut(Math.max(64, Math.min(catalog.hardLimits.maxOutputTokens, Number(e.target.value) || 64)))}
            />
          </div>
          <div className="field">
            <div className="label">Max cases</div>
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              min={1}
              max={catalog.hardLimits.maxCases}
              aria-label="Max cases"
              value={maxCases}
              onChange={(e) => setMaxCases(Math.max(1, Math.min(catalog.hardLimits.maxCases, Number(e.target.value) || 1)))}
            />
          </div>
          {estimate && (
            <div className={`alert ${estimate.known && estimate.maxUsd > maxCost ? "warning" : "info"} small`} style={{ marginTop: 8 }}>
              Sends {estimate.calls} request{estimate.calls === 1 ? "" : "s"} ({estimate.liveCases} cases) to <strong>{estimate.provider}</strong> · {estimate.model}.{" "}
              {estimate.known ? (
                <>
                  Worst-case estimate {usd(estimate.maxUsd)}.{estimate.maxUsd > maxCost && ` The run will stop at your ${usd(maxCost)} limit and be marked partial.`}
                </>
              ) : (
                <>No bundled pricing for this model, so the cost limit cannot be enforced; only the case limit applies.</>
              )}
            </div>
          )}
          <label className="row small" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I understand this sends the synthetic benchmark prompts (no personal data) to my AI provider and
            uses API credit.
          </label>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={running || (mode === "live" && !confirm)} onClick={start}>
          {running ? "Running…" : `Run ${mode === "live" ? "live" : "deterministic"} ${kind === "experiment" ? "experiment" : "evaluation"}`}
        </button>
      </div>
    </>
  );
}

function ResultsPanel({
  catalog,
  runs,
  selected,
  onSelect,
  onChanged,
  onError,
  onNotice,
  liveRun,
}: {
  catalog: EvalCatalog;
  runs: RunListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onError: (m: string) => void;
  onNotice: (m: string | null) => void;
  liveRun: EvalRun | null;
}) {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [filter, setFilter] = useState<"all" | "failed" | "issues">("issues");
  const [open, setOpen] = useState<string | null>(null);
  const id = selected ?? runs[0]?.id ?? null;
  useEffect(() => {
    if (!id) return setRun(null);
    void api.evalGet(id).then(setRun, (e) => onError(errMsg(e)));
  }, [id, runs, onError]);
  const shown = liveRun && liveRun.id === id ? liveRun : run;
  if (!runs.length && !liveRun) return <Empty title="No evaluation runs yet">Start a deterministic run from the Run tab; it needs no API key.</Empty>;
  const results = (shown?.results ?? []).filter((r) => filter === "all" || (filter === "failed" ? r.status === "failed" : r.status !== "passed"));
  const titleOf = (cid: string) => catalog.cases.find((c) => c.id === cid)?.title ?? cid;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, alignItems: "start" }}>
      <div className="card" style={{ padding: 0 }}>
        {runs.map((r) => (
          <button key={r.id} className="list-item" aria-selected={r.id === id} onClick={() => onSelect(r.id)}>
            <div className="row">
              <span className="title">{r.label ?? `${r.mode} · ${r.model}`}</span>
              {r.isBaseline && <span className="badge accent">Baseline</span>}
            </div>
            <div className="small muted">
              {formatTime(r.createdAt)} · <span className={`badge ${RUN_BADGE[r.status]}`}>{r.status}</span>
            </div>
            <div style={{ marginTop: 4 }}>
              <Counts c={r.counts} />
            </div>
          </button>
        ))}
      </div>
      {shown && (
        <div>
          <div className="card">
            <div className="row" style={{ flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>{shown.config.label ?? "Evaluation run"}</h3>
              <span className={`badge ${RUN_BADGE[shown.status]}`}>{shown.status}</span>
              <span style={{ flex: 1 }} />
              <button
                className="btn sm"
                disabled={shown.status !== "complete"}
                title={shown.status !== "complete" ? "Only a complete run can be the baseline." : undefined}
                onClick={() =>
                  void api
                    .evalSetBaseline(shown.id)
                    .then(onChanged)
                    .catch((e) => onError(errMsg(e)))
                }
              >
                Set as baseline
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  void api
                    .evalExport(shown.id)
                    .then((p) => p && onNotice(`Exported to ${p}.`))
                    .catch((e) => onError(errMsg(e)))
                }
              >
                Export JSON
              </button>
              <button
                className="btn sm danger"
                onClick={() =>
                  void api
                    .evalDelete(shown.id)
                    .then(onChanged)
                    .catch((e) => onError(errMsg(e)))
                }
              >
                Delete
              </button>
            </div>
            {shown.stopReason && (
              <div className="alert warning small" style={{ marginTop: 8 }}>
                {shown.stopReason}
              </div>
            )}
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Run</dt>
              <dd>
                {shown.id.slice(0, 8)} · {new Date(shown.createdAt).toLocaleString()}
              </dd>
              <dt>Mode / provider / model</dt>
              <dd>
                {shown.config.mode} · {shown.config.provider} · {shown.config.model}
              </dd>
              <dt>Prompt</dt>
              <dd>
                {shown.config.promptVersion} ({shown.config.promptHash})
              </dd>
              <dt>Context budget / verification</dt>
              <dd>
                {shown.config.contextBudgetChars.toLocaleString()} chars · {shown.config.verification ? "on" : "off"}
              </dd>
              <dt>Benchmark / repeats</dt>
              <dd>
                v{shown.benchmarkVersion} · {shown.config.repeat}×
              </dd>
            </dl>
          </div>

          <div className="stat-grid" style={{ marginTop: 12 }}>
            {(["passed", "failed", "inconclusive", "skipped", "not_run"] as const).map((k) => (
              <div className="stat" key={k}>
                <div className="v">{shown.summary.counts[k]}</div>
                <div className="l">{STATUS_LABEL[k]}</div>
              </div>
            ))}
            <div className="stat">
              <div className="v">{ms(shown.summary.latency.p50TotalMs)}</div>
              <div className="l">Total time p50 (n={shown.summary.latency.n})</div>
            </div>
            {shown.config.mode === "live" && (
              <>
                <div className="stat">
                  <div className="v">{ms(shown.summary.latency.p50TtftMs)}</div>
                  <div className="l">First token p50</div>
                </div>
                <div className="stat">
                  <div className="v">{shown.summary.usage.costKnown ? usd(shown.summary.usage.costUsd) : "unknown"}</div>
                  <div className="l">
                    Estimated cost · {shown.summary.usage.inputTokens.toLocaleString()} in / {shown.summary.usage.outputTokens.toLocaleString()} out tokens
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h3>By metric</h3>
            <p className="small muted">Each check counts towards one dimension. There is no combined score. Counts are checks, not cases.</p>
            <table className="data">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Checks passed</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(shown.metricDefinitions).map(([m, def]) => {
                  const s = shown.summary.byMetric[m as keyof typeof shown.summary.byMetric];
                  return (
                    <tr key={m}>
                      <td>{m.replace(/_/g, " ")}</td>
                      <td>{s ? `${s.passed} / ${s.total}` : "—"}</td>
                      <td className="small muted">{def}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>By category</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Inconclusive</th>
                  <th>Skipped</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(shown.summary.byCategory).map(([k, v]) => (
                  <tr key={k}>
                    <td>{catalog.categories[k as keyof typeof catalog.categories] ?? k}</td>
                    <td>{v.passed}</td>
                    <td>{v.failed}</td>
                    <td>{v.inconclusive}</td>
                    <td>{v.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {shown.summary.stability && shown.summary.stability.some((s) => s.passRate > 0 && s.passRate < 1) && (
            <div className="card">
              <h3>Unstable across repeats</h3>
              {shown.summary.stability
                .filter((s) => s.passRate > 0 && s.passRate < 1)
                .map((s) => (
                  <div key={s.caseId} className="small">
                    {s.caseId} · passed {Math.round(s.passRate * 100)}% of {s.runs} runs
                  </div>
                ))}
            </div>
          )}

          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>Cases</h3>
              <span style={{ flex: 1 }} />
              <Segmented<"all" | "failed" | "issues">
                label="Case filter"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "issues", label: "Not passed" },
                  { value: "failed", label: "Failed" },
                  { value: "all", label: "All" },
                ]}
              />
            </div>
            {!results.length && <p className="small muted">Nothing to show for this filter.</p>}
            {results.map((r) => {
              const key = `${r.caseId}#${r.attempt}`;
              return (
                <div key={key} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                  <button className="btn ghost" style={{ width: "100%", justifyContent: "flex-start", height: "auto" }} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                    <StatusBadge s={r.status} /> <span className="mono small">{r.caseId}</span> {titleOf(r.caseId)}
                    {shown.config.repeat > 1 && <span className="faint small"> · run {r.attempt}</span>}
                    <span style={{ flex: 1 }} />
                    <span className="faint small">{ms(r.latency.totalMs)}</span>
                  </button>
                  {open === key && <CaseDetail r={r} />}
                </div>
              );
            })}
          </div>

          <div className="card">
            <h3>Limitations</h3>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              {shown.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function CaseDetail({ r }: { r: EvalRun["results"][number] }) {
  return (
    <div className="col small" style={{ padding: "6px 4px 4px 12px" }}>
      {r.reason && <div className="alert warning small">{r.reason}</div>}
      <dl className="kv">
        <dt>Outcome</dt>
        <dd>
          {r.outcome}
          {r.errorCode ? ` (${r.errorCode})` : ""} · retries {r.retries}
        </dd>
        {r.intent && (
          <>
            <dt>Understood as</dt>
            <dd>
              {r.intent.relation} · {r.intent.category}
              {r.intent.ambiguous ? " · ambiguous" : ""}
            </dd>
          </>
        )}
        {r.model && (
          <>
            <dt>Model</dt>
            <dd>{r.model}</dd>
          </>
        )}
        {r.usage && (
          <>
            <dt>Usage</dt>
            <dd>
              {r.usage.inputTokens} in / {r.usage.outputTokens} out · {r.usage.costUsd == null ? "cost unknown" : usd(r.usage.costUsd)}
            </dd>
          </>
        )}
        {r.verificationFlags.length > 0 && (
          <>
            <dt>Answer checks flagged</dt>
            <dd>{r.verificationFlags.join(", ")}</dd>
          </>
        )}
        {r.warnings.length > 0 && (
          <>
            <dt>Warnings</dt>
            <dd>{r.warnings.join(" · ")}</dd>
          </>
        )}
      </dl>
      {r.checks.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th />
              <th>Check</th>
              <th>Metric</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {r.checks.map((c, i) => (
              <tr key={i}>
                <td>{c.passed ? "✓" : "✗"}</td>
                <td>
                  {c.describe}
                  <span className="faint"> · {c.scope}</span>
                </td>
                <td>{c.metric.replace(/_/g, " ")}</td>
                <td className="mono">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.input && (
        <details>
          <summary>Input sent ({r.input.historyMessages} earlier messages)</summary>
          <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
            {r.input.system}
            {"\n\n──── user turn ────\n\n"}
            {r.input.user}
          </pre>
        </details>
      )}
      {r.output !== undefined && (
        <details open={r.status === "failed"}>
          <summary>Model output</summary>
          <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
            {r.output || "(empty)"}
          </pre>
        </details>
      )}
    </div>
  );
}

function ComparePanel({ runs, onError }: { runs: RunListItem[]; onError: (m: string) => void }) {
  const baseline = runs.find((r) => r.isBaseline);
  const [a, setA] = useState<string>(baseline?.id ?? runs[1]?.id ?? "");
  const [b, setB] = useState<string>(runs.find((r) => r.id !== (baseline?.id ?? runs[1]?.id))?.id ?? "");
  const [cmp, setCmp] = useState<RunComparison | null>(null);
  const [filter, setFilter] = useState<"changed" | "all">("changed");
  useEffect(() => {
    if (!a || !b || a === b) return setCmp(null);
    void api.evalCompare(a, b).then(setCmp, (e) => onError(errMsg(e)));
  }, [a, b, onError]);
  const label = (r: RunListItem) => `${r.isBaseline ? "★ " : ""}${r.label ?? `${r.mode} · ${r.model}`} · ${formatTime(r.createdAt)} · ${r.status}`;
  const rows = useMemo(() => (cmp ? cmp.cases.filter((c) => filter === "all" || c.verdict !== "unchanged") : []), [cmp, filter]);
  if (runs.length < 2) return <Empty title="Need two runs to compare">Run an evaluation twice (for example before and after a change), or run an experiment.</Empty>;
  return (
    <>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="small muted" htmlFor="cmp-a">
            Baseline
          </label>
          <select id="cmp-a" className="select" style={{ maxWidth: 360 }} value={a} onChange={(e) => setA(e.target.value)}>
            <option value="">Choose…</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
          <label className="small muted" htmlFor="cmp-b">
            Candidate
          </label>
          <select id="cmp-b" className="select" style={{ maxWidth: 360 }} value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">Choose…</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </div>
        <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Evidence only: Lumen never changes prompts, routing or settings based on a comparison.
        </p>
      </div>
      {cmp && (
        <>
          {cmp.warnings.map((w) => (
            <div key={w} className="alert warning small" style={{ marginTop: 8 }}>
              {w}
            </div>
          ))}
          <div className="stat-grid" style={{ marginTop: 12 }}>
            {(["improved", "regressed", "unchanged", "inconclusive"] as const).map((k) => (
              <div className="stat" key={k}>
                <div className="v">{cmp.counts[k]}</div>
                <div className="l">{k}</div>
              </div>
            ))}
            <div className="stat">
              <div className="v">{cmp.latency.deltaMs == null ? "—" : `${cmp.latency.deltaMs > 0 ? "+" : ""}${Math.round(cmp.latency.deltaMs)} ms`}</div>
              <div className="l">
                Total time p50 ({ms(cmp.latency.baselineP50Ms)} → {ms(cmp.latency.candidateP50Ms)})
              </div>
            </div>
            <div className="stat">
              <div className="v">{cmp.cost.known ? `${cmp.cost.deltaUsd >= 0 ? "+" : ""}${usd(cmp.cost.deltaUsd)}` : "unknown"}</div>
              <div className="l">Estimated cost change</div>
            </div>
          </div>
          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>Per case</h3>
              <span style={{ flex: 1 }} />
              <Segmented<"changed" | "all">
                label="Comparison filter"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "changed", label: "Changed" },
                  { value: "all", label: "All" },
                ]}
              />
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Verdict</th>
                  <th>Baseline</th>
                  <th>Candidate</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.caseId}>
                    <td className="mono">{c.caseId}</td>
                    <td>
                      <span className={`badge ${VERDICT_BADGE[c.verdict]}`}>{c.verdict}</span>
                    </td>
                    <td>{c.baseline.passRate == null ? c.baseline.status || "—" : `${Math.round(c.baseline.passRate * 100)}% (n=${c.baseline.runs})`}</td>
                    <td>{c.candidate.passRate == null ? c.candidate.status || "—" : `${Math.round(c.candidate.passRate * 100)}% (n=${c.candidate.runs})`}</td>
                    <td className="small">
                      {c.reason}
                      {c.changedChecks.map((x) => (
                        <div key={x.describe} className="faint">
                          {x.candidate ? "✓" : "✗"} {x.describe}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="small muted">No case changed between these runs.</p>}
          </div>
        </>
      )}
    </>
  );
}

function CasesPanel({ catalog }: { catalog: EvalCatalog }) {
  const [cat, setCat] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);
  const cases = catalog.cases.filter((c) => cat === "all" || c.category === cat);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="select" style={{ width: 320 }} aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories ({catalog.cases.length})</option>
          {Object.entries(catalog.categories).map(([k, label]) => (
            <option key={k} value={k}>
              {label} ({catalog.cases.filter((c) => c.category === k).length})
            </option>
          ))}
        </select>
        <span className="small muted">Prompt versions: {catalog.prompts.map((p) => p.id).join(", ")}</span>
      </div>
      {cases.map((c) => (
        <div className="card" key={c.id}>
          <button className="btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
            <span className="mono small">{c.id}</span> <strong>{c.title}</strong>
            <span style={{ flex: 1 }} />
            <span className="badge">{c.difficulty}</span>
            {c.deterministicOnly && <span className="badge">deterministic only</span>}
            {c.liveOnly && <span className="badge">live only</span>}
          </button>
          {open === c.id && (
            <div className="col small" style={{ marginTop: 8 }}>
              <dl className="kv">
                <dt>Request</dt>
                <dd>
                  {c.request.question}
                  {c.request.style ? ` · style ${c.request.style}` : ""}
                  {c.request.mode ? ` · ${c.request.mode} session` : ""}
                </dd>
                <dt>Fixtures</dt>
                <dd>{c.fixtures.length ? c.fixtures.map((f) => f.kind).join(", ") : "none"}</dd>
                <dt>Method</dt>
                <dd>{c.method}</dd>
              </dl>
              <div>
                <strong>Acceptance criteria</strong>
                <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                  {c.pipeline.map((p, i) => (
                    <li key={`p${i}`}>
                      {p.describe} <span className="faint">· request · {p.metric.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                  {c.answer.map((p, i) => (
                    <li key={`a${i}`}>
                      {p.describe} <span className="faint">· answer (live) · {p.metric.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Fails if</strong>
                <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                  {c.failureConditions.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
