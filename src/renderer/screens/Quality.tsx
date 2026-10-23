import { useEffect, useState } from "react";
import type { EvalCase, FeedbackRecord, Proposal, QualityMetrics } from "../../shared/api";
import { api, errMsg, formatTime } from "../lib/api";
import { Empty, Segmented } from "../components/ui";

type Tab = "overview" | "feedback" | "proposals" | "cases";
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const ms = (v: number | null) => (v == null ? "—" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const SEV = { high: "danger", medium: "warning", low: "" } as const;
const LABEL: Record<string, string> = {
  helpful: "Helpful",
  incorrect: "Incorrect",
  incomplete: "Incomplete",
  irrelevant_context: "Irrelevant context",
  too_slow: "Too slow",
  too_verbose: "Too verbose",
  bad_formatting: "Incorrect formatting",
  other: "Other",
};

/** Developer/diagnostics area: metrics from recorded events, feedback, proposals, user cases. */
export function QualityScreen() {
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <header className="page-header">
        <h1>Quality</h1>
        <span className="muted small">Computed from events recorded on this computer. Nothing here is sent anywhere.</span>
        <span className="spacer" />
        <Segmented<Tab>
          label="Quality view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "overview", label: "Overview" },
            { value: "feedback", label: "Feedback" },
            { value: "proposals", label: "Proposals" },
            { value: "cases", label: "My test cases" },
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
        {tab === "overview" && <Overview onError={setError} />}
        {tab === "feedback" && <FeedbackList onError={setError} onCase={() => setTab("cases")} />}
        {tab === "proposals" && <Proposals onError={setError} />}
        {tab === "cases" && <UserCases onError={setError} />}
      </div>
    </>
  );
}

function Overview({ onError }: { onError: (m: string) => void }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [m, setM] = useState<QualityMetrics | null>(null);
  useEffect(() => {
    void api.qualityMetrics(Number(days)).then(setM, (e) => onError(errMsg(e)));
  }, [days, onError]);
  if (!m) return null;
  if (!m.requests)
    return <Empty title="No requests recorded yet">Metrics appear here after you ask Lumen questions. Only event types, models, task categories, error codes and timings are recorded.</Empty>;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Segmented<"7" | "30" | "90">
          label="Window"
          value={days}
          onChange={setDays}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
        {m.preliminary && <span className="badge warning">Preliminary: {m.requests} requests (fewer than 30)</span>}
      </div>
      <div className="stat-grid">
        <Stat v={String(m.requests)} l="Requests" />
        <Stat v={pct(m.successRate)} l="Completed" />
        <Stat v={pct(m.cancellationRate)} l="Stopped by you" />
        <Stat v={String(m.failed)} l="Failed" />
        <Stat v={String(m.retries)} l="Automatic retries" />
        <Stat v={ms(m.latency.p50Ms)} l={`Total time p50 (n=${m.latency.n})`} />
        <Stat v={ms(m.latency.p95Ms)} l="Total time p95" />
        <Stat v={ms(m.latency.ttftP50Ms)} l="First token p50" />
      </div>
      <div className="card">
        <h3>By provider</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Requests</th>
              <th>Failed</th>
              <th>Error rate</th>
            </tr>
          </thead>
          <tbody>
            {m.byProvider.map((p) => (
              <tr key={p.provider}>
                <td>{p.provider}</td>
                <td>{p.requests}</td>
                <td>{p.failed}</td>
                <td>{pct(p.errorRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Daily</h3>
        <table className="data">
          <thead>
            <tr>
              <th>Day</th>
              <th>Requests</th>
              <th>Failed</th>
              <th>Total time p50</th>
            </tr>
          </thead>
          <tbody>
            {m.daily.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{d.requests}</td>
                <td>{d.failed}</td>
                <td>{ms(d.p50Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <Breakdown title="Failures by error" rows={m.failuresByCode} />
        <Breakdown title="Answer checks flagged" rows={m.verificationByCheck} />
        <Breakdown title="Feedback" rows={m.feedbackByKind} labels={LABEL} />
      </div>
      <p className="small faint">Cost estimates are under AI provider → Usage. Benchmark quality is in the Evaluation Lab.</p>
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

function Breakdown({ title, rows, labels }: { title: string; rows: Record<string, number>; labels?: Record<string, string> }) {
  const e = Object.entries(rows).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card" style={{ flex: 1, marginTop: 0 }}>
      <h3>{title}</h3>
      {!e.length && <div className="small muted">None recorded.</div>}
      {e.map(([k, n]) => (
        <div key={k} className="row small">
          <span>{labels?.[k] ?? k}</span>
          <span className="spacer" />
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}

function FeedbackList({ onError, onCase }: { onError: (m: string) => void; onCase: () => void }) {
  const [items, setItems] = useState<FeedbackRecord[] | null>(null);
  const [draft, setDraft] = useState<{ feedbackId: string; text: string; question: string; answer: string; warnings: string[] } | null>(null);
  const load = () => void api.listFeedback().then(setItems, (e) => onError(errMsg(e)));
  useEffect(load, [onError]);
  if (!items) return null;
  if (!items.length) return <Empty title="No feedback yet">Use “Feedback” under any answer. It is stored only on this computer.</Empty>;
  return (
    <>
      <p className="small muted">
        Stored locally with the answer's task type, model, route, timings and answer-check results. The question and answer are not copied into feedback; they're read from the conversation only if you
        create a test case. Deleting the conversation leaves this metadata; delete it here.
      </p>
      {draft && (
        <div className="card">
          <h3>Review the proposed test case</h3>
          {draft.warnings.map((w) => (
            <div key={w} className="alert warning small" style={{ marginBottom: 6 }}>
              {w}
            </div>
          ))}
          <details className="small" style={{ margin: "6px 0" }}>
            <summary>Original answer (for reference; not saved)</summary>
            <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
              {draft.answer}
            </pre>
          </details>
          <p className="small muted">
            Edit the case below (JSON). Keep only synthetic fixtures. Checks must be objective; you can't change the shipped benchmark from here, and editing a saved case later makes earlier
            comparisons inconclusive rather than passing.
          </p>
          <textarea className="textarea mono" rows={18} aria-label="Test case definition" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                let def: EvalCase;
                try {
                  def = JSON.parse(draft.text) as EvalCase;
                } catch (e) {
                  return onError(`Not valid JSON: ${(e as Error).message}`);
                }
                void api
                  .saveCase(def, draft.feedbackId)
                  .then(() => {
                    setDraft(null);
                    onCase();
                  })
                  .catch((e) => onError(errMsg(e)));
              }}
            >
              Save to my test cases
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Rating</th>
              <th>Task</th>
              <th>Model / route</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td className="small">{formatTime(f.createdAt)}</td>
                <td>
                  <span className={`badge ${f.kind === "helpful" ? "success" : "warning"}`}>{LABEL[f.kind] ?? f.kind}</span>
                </td>
                <td>{f.meta.category ?? "—"}</td>
                <td className="small">
                  {f.meta.model ?? "—"}
                  {f.meta.route ? ` · ${f.meta.route}` : ""}
                </td>
                <td className="small">
                  {f.note ?? ""}
                  {f.expected ? <div className="faint">Expected: {f.expected}</div> : null}
                </td>
                <td>
                  <div className="row">
                    {f.kind !== "helpful" && f.messageId && (
                      <button
                        className="btn sm"
                        onClick={() =>
                          void api
                            .draftCase(f.id)
                            .then((d) => setDraft({ feedbackId: f.id, text: JSON.stringify(d.draft, null, 2), question: d.question, answer: d.answer, warnings: d.warnings }))
                            .catch((e) => onError(errMsg(e)))
                        }
                      >
                        Create test case
                      </button>
                    )}
                    <button
                      className="btn sm danger"
                      onClick={() =>
                        void api
                          .deleteFeedback(f.id)
                          .then(load)
                          .catch((e) => onError(errMsg(e)))
                      }
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn danger"
        style={{ marginTop: 12 }}
        onClick={() =>
          void api
            .clearQuality()
            .then(load)
            .catch((e) => onError(errMsg(e)))
        }
      >
        Delete all feedback, quality events and my test cases
      </button>
    </>
  );
}

function Proposals({ onError }: { onError: (m: string) => void }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  useEffect(() => {
    void api.qualityProposals().then(setItems, (e) => onError(errMsg(e)));
  }, [onError]);
  if (!items) return null;
  if (!items.length)
    return (
      <Empty title="No proposals">
        Proposals appear when recorded data shows a recurring problem (at least 5 occurrences), when the latest benchmark run has failures, or when it regressed against the baseline. Nothing is
        proposed from too little data.
      </Empty>
    );
  return (
    <>
      <p className="small muted">Evidence for a developer to review. Lumen never applies these itself. Findings from fewer than 30 observations are marked preliminary.</p>
      {items.map((p) => (
        <div className="card" key={p.id}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className={`badge ${SEV[p.severity]}`}>{p.severity}</span>
            <strong>{p.title}</strong>
            {p.preliminary && <span className="badge warning">preliminary · n={p.sampleSize}</span>}
            <span className="spacer" />
            <span className="small faint">
              priority {p.priority} · effort {p.effort}/3
            </span>
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Evidence</dt>
            <dd>
              {p.evidence.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </dd>
            {p.categories.length > 0 && (
              <>
                <dt>Task categories</dt>
                <dd>{p.categories.join(", ")}</dd>
              </>
            )}
            <dt>Possible causes</dt>
            <dd>{p.rootCauses.join(" · ")}</dd>
            <dt>Suggestion</dt>
            <dd>{p.suggestion}</dd>
            <dt>Expected benefit</dt>
            <dd>{p.benefits}</dd>
            <dt>Risks</dt>
            <dd>{p.risks}</dd>
            <dt>How to verify</dt>
            <dd>{p.verification}</dd>
          </dl>
        </div>
      ))}
    </>
  );
}

function UserCases({ onError }: { onError: (m: string) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.userCases>> | null>(null);
  const [running, setRunning] = useState(false);
  const load = () => void api.userCases().then(setItems, (e) => onError(errMsg(e)));
  useEffect(load, [onError]);
  useEffect(
    () =>
      api.onEval((e) => {
        if (e.type === "finished") {
          setRunning(false);
          if (e.error) onError(e.error);
          load();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  if (!items) return null;
  if (!items.length) return <Empty title="No test cases of your own yet">Create one from a feedback entry. They stay on this computer, separate from the shipped benchmark.</Empty>;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className="btn primary"
          disabled={running}
          onClick={() => {
            setRunning(true);
            void api.evalStart({ mode: "deterministic", collection: "user" }).catch((e) => (setRunning(false), onError(errMsg(e))));
          }}
        >
          {running ? "Running…" : "Run my cases (deterministic)"}
        </button>
        <span className="small muted">Answer checks need a real model: run them live from the Evaluation Lab with the “My cases” collection. Results are kept for regression comparison.</span>
      </div>
      {items.map((u) => (
        <div className="card" key={u.case.id}>
          <div className="row">
            <span className="mono small">{u.case.id}</span>
            <strong>{u.case.title}</strong>
            <span className="spacer" />
            {u.lastRun ? (
              <span className={`badge ${u.lastRun.status === "passed" ? "success" : u.lastRun.status === "failed" ? "danger" : "warning"}`}>{u.lastRun.status}</span>
            ) : (
              <span className="badge">Not yet evaluated</span>
            )}
            <button
              className="btn sm danger"
              onClick={() =>
                void api
                  .deleteUserCase(u.case.id)
                  .then(load)
                  .catch((e) => onError(errMsg(e)))
              }
            >
              Delete
            </button>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {u.case.request.question.slice(0, 200)}
          </div>
          {u.lastRun && (
            <div className="small" style={{ marginTop: 6 }}>
              Last run {formatTime(u.lastRun.at)}:{" "}
              {u.lastRun.checks.map((c) => (
                <div key={c.describe}>
                  {c.passed ? "✓" : "✗"} {c.describe} <span className="faint mono">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
