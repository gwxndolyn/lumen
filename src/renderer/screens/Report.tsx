import { useEffect, useState } from "react";
import type { ReportInput, ReportRecord } from "../../shared/api";
import { api, errMsg, formatTs } from "../lib/api";
import { Empty } from "../components/ui";

// Labels mirror src/core/beta/report.ts (the renderer can't import Node code).
const CATEGORIES: { value: ReportInput["category"]; label: string; hint: string }[] = [
  { value: "broken", label: "Something doesn't work", hint: "A feature fails or behaves unexpectedly." },
  { value: "crash", label: "Crash or unexpected error", hint: "Lumen closed, froze, or showed an error you didn't expect." },
  { value: "answer_quality", label: "Incorrect or low-quality answer", hint: "Pick the answer below so the team can see its task type, model and timings." },
  { value: "capture", label: "Screen, transcription or context problem", hint: "Capture, OCR, live transcript or attached context." },
  { value: "performance", label: "Slow or unresponsive", hint: "Say roughly how long it took and what you were doing." },
  { value: "confusing", label: "Confusing workflow", hint: "Where did you expect something different?" },
  { value: "missing_feature", label: "Missing functionality", hint: "Something you needed to finish a task." },
  { value: "feature_request", label: "Feature request", hint: "An idea for something new." },
  { value: "usefulness", label: "Overall usefulness", hint: "How useful is Lumen for your work so far?" },
  { value: "privacy", label: "Privacy or security concern", hint: "Anything that captured, kept or sent more than you expected." },
  { value: "other", label: "Other", hint: "" },
];
const AREAS: [NonNullable<ReportInput["area"]>, string][] = [
  ["assistant", "Assistant / answers"],
  ["screen_capture", "Screen capture"],
  ["transcription", "Transcription"],
  ["knowledge", "Knowledge base"],
  ["memory", "Project memory"],
  ["sessions", "Sessions & history"],
  ["provider_setup", "AI provider setup"],
  ["local_model", "Local model"],
  ["onboarding", "Onboarding"],
  ["settings", "Settings"],
  ["updates", "Updates"],
  ["other", "Other"],
];
const STATUS: Record<ReportRecord["status"], [string, string]> = {
  draft: ["Draft", ""],
  exported: ["Saved to file", "success"],
  export_failed: ["Save failed", "danger"],
};

const empty = (messageId: string | null): ReportInput => ({
  category: messageId ? "answer_quality" : "broken",
  description: "",
  severity: null,
  area: null,
  steps: null,
  usefulness: null,
  messageId,
  include: { diagnostics: false, usage: false, excerpt: false },
  excerpt: null,
});

/** Messages from the Assistant ("Report a problem" on an answer) arrive as #/main/report?answer=<id>. */
function answerFromHash(): string | null {
  const m = /[?&]answer=([A-Za-z0-9-]{1,100})/.exec(location.hash);
  return m ? m[1]! : null;
}

export function ReportScreen() {
  const [reports, setReports] = useState<ReportRecord[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: ReportInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    void api.listReports().then(
      (r) => setReports(r),
      (e) => setError(errMsg(e)),
    );
  useEffect(() => {
    load();
    const a = answerFromHash();
    if (a) setEditing({ id: null, input: empty(a) });
  }, []);

  return (
    <>
      <header className="page-header">
        <h1>Send feedback</h1>
        <span className="muted small">Saved as a file you send to the Lumen team. Nothing is uploaded.</span>
        <span className="spacer" />
        {!editing && (
          <button className="btn primary" onClick={() => setEditing({ id: null, input: empty(null) })}>
            New report
          </button>
        )}
      </header>
      <div className="page narrow">
        {error && (
          <div className="alert error small" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {editing ? (
          <ReportEditor
            key={editing.id ?? "new"}
            initial={editing}
            onClose={() => {
              setEditing(null);
              load();
            }}
          />
        ) : (
          <ReportList reports={reports} onOpen={(r) => setEditing({ id: r.id, input: r.input })} onChanged={load} onError={setError} />
        )}
      </div>
    </>
  );
}

function ReportList({ reports, onOpen, onChanged, onError }: { reports: ReportRecord[] | null; onOpen: (r: ReportRecord) => void; onChanged: () => void; onError: (m: string) => void }) {
  if (!reports) return null;
  return (
    <>
      <div className="card">
        <h3>How beta feedback works</h3>
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Describe the problem or idea. Drafts are kept on this computer until you save or discard them.</li>
          <li>Choose what to include. Diagnostics and answer text are off unless you tick them.</li>
          <li>Preview the exact file, then save it and send it to the Lumen team (Help → Beta feedback says where).</li>
        </ol>
      </div>
      {!reports.length ? (
        <Empty title="No reports yet">Use “New report”, or “Report” under any answer.</Empty>
      ) : (
        <div className="card">
          <h3>Your reports</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Report</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div>{CATEGORIES.find((c) => c.value === r.input.category)?.label}</div>
                    <div className="small faint">{r.input.description.slice(0, 80)}</div>
                  </td>
                  <td>
                    <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                    {r.status === "exported" && r.exportedName && <div className="small faint">{r.exportedName}</div>}
                    {r.lastError && <div className="small faint">{r.lastError}</div>}
                  </td>
                  <td className="small">{formatTs(r.updatedAt)}</td>
                  <td>
                    <div className="row">
                      <button className="btn sm" onClick={() => onOpen(r)}>
                        {r.status === "exported" ? "Open" : r.status === "export_failed" ? "Retry" : "Continue"}
                      </button>
                      <button
                        className="btn sm ghost danger"
                        onClick={() =>
                          void api
                            .discardReport(r.id)
                            .then(onChanged)
                            .catch((e) => onError(errMsg(e)))
                        }
                      >
                        {r.status === "exported" ? "Remove" : "Discard"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small faint" style={{ marginTop: 8 }}>
            Removing a report here doesn't delete a file you already saved or sent. Reports follow your conversation retention setting.
          </p>
        </div>
      )}
    </>
  );
}

type Preview = Awaited<ReturnType<typeof api.previewReport>>;

function ReportEditor({ initial, onClose }: { initial: { id: string | null; input: ReportInput }; onClose: () => void }) {
  const [id, setId] = useState(initial.id);
  const [input, setInput] = useState<ReportInput>(initial.input);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy"; what: string } | { kind: "error"; message: string } | { kind: "saved"; path: string }>({ kind: "idle" });
  const [excerptAvailable, setExcerptAvailable] = useState<boolean | null>(null);
  const set = (patch: Partial<ReportInput>) => {
    setInput((i) => ({ ...i, ...patch }));
    setPreview(null);
    if (state.kind === "saved" || state.kind === "error") setState({ kind: "idle" });
  };
  const cat = CATEGORIES.find((c) => c.value === input.category)!;

  useEffect(() => {
    if (!input.messageId) return;
    void api.reportExcerpt(input.messageId).then(
      (x) => setExcerptAvailable(!!x),
      () => setExcerptAvailable(false),
    );
  }, [input.messageId]);

  const persist = async () => {
    const rec = await api.saveReport(id, input);
    setId(rec.id);
    return rec;
  };
  const run = async (what: string, fn: () => Promise<void>) => {
    setState({ kind: "busy", what });
    try {
      await fn();
    } catch (e) {
      setState({ kind: "error", message: errMsg(e) });
    }
  };
  const doPreview = () =>
    run("Preparing preview…", async () => {
      const rec = await persist();
      setPreview(await api.previewReport(rec.id));
      setState({ kind: "idle" });
    });
  const doExport = () =>
    run("Saving…", async () => {
      const rec = await persist();
      const res = await api.exportReport(rec.id);
      setState(res ? { kind: "saved", path: res.path } : { kind: "idle" });
    });
  const toggleExcerpt = async (on: boolean) => {
    if (on && !input.excerpt && input.messageId) {
      const x = await api.reportExcerpt(input.messageId).catch(() => null);
      if (!x) return setState({ kind: "error", message: "That answer no longer exists, so there is nothing to include." });
      set({ include: { ...input.include, excerpt: true }, excerpt: x });
    } else set({ include: { ...input.include, excerpt: on } });
  };
  const busy = state.kind === "busy";
  const canSubmit = input.description.trim().length > 0 && !busy;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card">
        <div className="field">
          <label htmlFor="rep-cat">What is this about?</label>
          <select id="rep-cat" className="select" value={input.category} onChange={(e) => set({ category: e.target.value as ReportInput["category"] })}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {cat.hint && <div className="small faint">{cat.hint}</div>}
        </div>
        {input.category === "usefulness" && (
          <div className="field">
            <label>How useful is Lumen for your work?</label>
            <div className="row" role="radiogroup" aria-label="Usefulness">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} role="radio" aria-checked={input.usefulness === n} className={`btn sm ${input.usefulness === n ? "primary" : ""}`} onClick={() => set({ usefulness: n })}>
                  {n}
                </button>
              ))}
              <span className="small faint">1 = not useful · 5 = essential</span>
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="rep-desc">Description</label>
          <textarea
            id="rep-desc"
            className="textarea"
            rows={5}
            maxLength={4000}
            value={input.description}
            placeholder="What happened, and what did you expect?"
            onChange={(e) => set({ description: e.target.value })}
          />
          <div className="small faint">{input.description.length} / 4000 · API keys, passwords and card numbers you type are masked.</div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="rep-sev">Impact (optional)</label>
            <select id="rep-sev" className="select" value={input.severity ?? ""} onChange={(e) => set({ severity: (e.target.value || null) as ReportInput["severity"] })}>
              <option value="">Not specified</option>
              <option value="blocker">Blocks my work</option>
              <option value="major">Major: hard to work around</option>
              <option value="minor">Minor: annoying</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="rep-area">Area (optional)</label>
            <select id="rep-area" className="select" value={input.area ?? ""} onChange={(e) => set({ area: (e.target.value || null) as ReportInput["area"] })}>
              <option value="">Not specified</option>
              {AREAS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rep-steps">Steps to reproduce (optional)</label>
          <textarea id="rep-steps" className="textarea" rows={3} maxLength={2000} value={input.steps ?? ""} placeholder="1. … 2. … 3. …" onChange={(e) => set({ steps: e.target.value || null })} />
        </div>
      </div>

      <div className="card">
        <h3>What to include</h3>
        <p className="small muted">Off by default. Everything you tick appears in the preview before anything is saved.</p>
        {input.messageId && (
          <div className="alert info small" style={{ marginBottom: 8 }}>
            Linked to one answer: its task type, model, timings and answer-check results are included (not its text).{" "}
            <button className="btn sm ghost" onClick={() => set({ messageId: null, include: { ...input.include, excerpt: false }, excerpt: null })}>
              Unlink
            </button>
          </div>
        )}
        <label className="row small">
          <input type="checkbox" checked={input.include.diagnostics} onChange={(e) => set({ include: { ...input.include, diagnostics: e.target.checked } })} />
          Diagnostics: app state, error codes, timings and operational log events from the last 24 hours
        </label>
        <label className="row small">
          <input type="checkbox" checked={input.include.usage} onChange={(e) => set({ include: { ...input.include, usage: e.target.checked } })} />
          Usage summary: request counts, success rate, setup milestones (counts only)
        </label>
        {input.messageId && (
          <label className="row small">
            <input type="checkbox" checked={input.include.excerpt} disabled={excerptAvailable === false} onChange={(e) => void toggleExcerpt(e.target.checked)} />
            The question and answer text (you can edit it below)
            {excerptAvailable === false && <span className="faint"> — the answer was deleted</span>}
          </label>
        )}
        {input.include.excerpt && input.excerpt && (
          <div className="col" style={{ marginTop: 8 }}>
            <div className="alert warning small">
              This text leaves your computer when you send the file. Remove names, code or anything private that the team doesn't need to understand the problem.
            </div>
            <label className="small" htmlFor="rep-ex-q">
              Question
            </label>
            <textarea id="rep-ex-q" className="textarea" rows={3} maxLength={2000} value={input.excerpt.question} onChange={(e) => set({ excerpt: { ...input.excerpt!, question: e.target.value } })} />
            <label className="small" htmlFor="rep-ex-a">
              Answer
            </label>
            <textarea id="rep-ex-a" className="textarea" rows={5} maxLength={2000} value={input.excerpt.answer} onChange={(e) => set({ excerpt: { ...input.excerpt!, answer: e.target.value } })} />
          </div>
        )}
      </div>

      {preview && (
        <div className="card" aria-label="Report preview">
          <h3>Preview: exactly what will be saved ({(preview.bytes / 1024).toFixed(1)} KB)</h3>
          {preview.warnings.map((w) => (
            <div key={w} className="alert warning small" style={{ marginBottom: 6 }}>
              {w}
            </div>
          ))}
          <div className="row small" style={{ alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <strong>Included</strong>
              <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                {preview.contents.included.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div style={{ flex: 1 }}>
              <strong>Not included</strong>
              <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                {preview.contents.excluded.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
          <details className="small">
            <summary>Show the file</summary>
            <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
              {preview.text}
            </pre>
          </details>
        </div>
      )}

      {state.kind === "error" && (
        <div className="alert error small" role="alert">
          {state.message}{" "}
          <button className="btn sm" onClick={() => (preview ? void doExport() : void doPreview())}>
            Try again
          </button>
        </div>
      )}
      {state.kind === "saved" && (
        <div className="alert info small" role="status">
          Saved to {state.path}. It has <strong>not</strong> been sent: attach this file to your message to the Lumen team.{" "}
          <button className="btn sm ghost" onClick={() => void api.revealFile(state.path)}>
            Show in folder
          </button>
        </div>
      )}

      <div className="row">
        <button className="btn" disabled={!canSubmit} onClick={() => void doPreview()}>
          Preview
        </button>
        <button className="btn primary" disabled={!canSubmit || !preview} title={preview ? "" : "Preview first"} onClick={() => void doExport()}>
          Save report file…
        </button>
        <button
          className="btn ghost"
          disabled={busy || !input.description.trim()}
          onClick={() =>
            void run("Saving draft…", async () => {
              await persist();
              onClose();
            })
          }
        >
          Keep as draft
        </button>
        <span className="spacer" />
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          {state.kind === "saved" ? "Done" : "Close"}
        </button>
        {state.kind === "busy" && <span className="small faint">{state.what}</span>}
      </div>
    </div>
  );
}
