import { useEffect, useState } from "react";
import type { BudgetStatus, EntitlementState, UpdateCheck, UsageRow } from "../../shared/api";
import { api, errMsg, usd } from "../lib/api";

const FEATURES: { key: keyof EntitlementState["features"]; label: string; free: string }[] = [
  { key: "hybrid_routing", label: "Hybrid local/cloud routing", free: "Manual choice of cloud or local model" },
  { key: "semantic_search", label: "Semantic knowledge search (local embeddings)", free: "Keyword knowledge search" },
  { key: "live_evaluation", label: "Live model evaluations and experiments", free: "Deterministic evaluations" },
  { key: "unlimited_memory", label: "Unlimited project memory", free: "Up to 50 memories" },
];

/** Plan, license, usage and updates. Lumen itself takes no payment in the app. */
export function PlanScreen() {
  const [st, setSt] = useState<EntitlementState | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ rows: UsageRow[]; budget: BudgetStatus } | null>(null);
  const [upd, setUpd] = useState<UpdateCheck | "checking" | null>(null);
  const [version, setVersion] = useState("");
  useEffect(() => {
    void api.planState().then(setSt, (e) => setError(errMsg(e)));
    void api.usageReport(30).then(setUsage);
    void api.appInfo().then((i) => setVersion(i.version));
  }, []);
  if (!st) return null;
  const local = usage?.rows.filter((r) => r.provider === "ollama").reduce((n, r) => n + r.requests, 0) ?? 0;
  const cloud = usage?.rows.filter((r) => r.provider !== "ollama" && r.provider !== "mock").reduce((n, r) => n + r.requests, 0) ?? 0;
  const unknownCost = usage?.rows.some((r) => r.costBasis === "none" && r.requests > 0);
  return (
    <>
      <header className="page-header">
        <h1>Plan &amp; updates</h1>
        <span className="muted small">Lumen {version}</span>
      </header>
      <div className="page narrow">
        {error && (
          <div className="alert error small" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {notice && (
          <div className="alert info small" role="status" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        <div className="card">
          <h3>Your plan: {st.plan === "pro" ? "Pro" : st.plan === "open" ? "All features" : "Free"}</h3>
          <p className="small muted">{st.message}</p>
          {st.license?.email && <p className="small muted">Licensed to {st.license.email}.</p>}
          <table className="data">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Included</th>
                <th>On Free</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Assistant, screen and document context, transcripts, notes, history</td>
                <td>✓</td>
                <td>✓</td>
              </tr>
              <tr>
                <td>Your own Anthropic / OpenAI / Gemini key, or a local model</td>
                <td>✓</td>
                <td>✓</td>
              </tr>
              {FEATURES.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  <td>{st.features[f.key] ? "✓" : "—"}</td>
                  <td className="small muted">{f.free}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small faint" style={{ marginTop: 8 }}>
            Lumen doesn't sell AI usage. Questions sent to a cloud provider are billed by that provider to your own key; local models cost nothing per question. Your data is never locked: if a license
            lapses, Pro features turn off and everything you saved stays available.
          </p>
        </div>

        {st.licensingEnabled && (
          <div className="card">
            <h3>License key</h3>
            {st.license && st.status !== "invalid" ? (
              <div className="row">
                <span className="small">
                  Key {st.license.id.slice(0, 8)}… · {st.license.expiresAt ? `valid until ${new Date(st.license.expiresAt).toLocaleDateString()}` : "perpetual"}
                </span>
                <span className="spacer" />
                <button
                  className="btn sm"
                  onClick={() =>
                    void api
                      .planDeactivate()
                      .then((s) => (setSt(s), setNotice("License removed from this computer. You can add it again at any time.")))
                      .catch((e) => setError(errMsg(e)))
                  }
                >
                  Remove from this computer
                </button>
              </div>
            ) : (
              <>
                <p className="small muted">Paste the key from your purchase email. It's checked on this computer; no account or internet connection is needed.</p>
                <div className="row">
                  <input className="input mono" aria-label="License key" placeholder="LUMEN1.…" value={key} onChange={(e) => setKey(e.target.value)} />
                  <button
                    className="btn primary"
                    disabled={!key.trim()}
                    onClick={() =>
                      void api
                        .planActivate(key)
                        .then((s) => (setSt(s), setKey(""), setError(null), setNotice("License activated.")))
                        .catch((e) => setError(errMsg(e)))
                    }
                  >
                    Activate
                  </button>
                </div>
              </>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => void api.planPurchase().catch((e) => setError(errMsg(e)))}>
                {st.plan === "pro" ? "Manage or renew" : "Get Pro"}
              </button>
              <span className="small faint">Opens the store in your browser. Payment happens there, not in Lumen.</span>
            </div>
          </div>
        )}

        <div className="card">
          <h3>Usage (last 30 days)</h3>
          {usage ? (
            <>
              <p className="small muted">
                {cloud} cloud request{cloud === 1 ? "" : "s"}, {local} local. Estimated provider cost {usd(usage.rows.reduce((n, r) => n + r.costUsd, 0))}
                {unknownCost ? " plus requests to models Lumen has no price for" : ""} — billed by your provider, not Lumen. Today: {usd(usage.budget.daily.spentUsd)}
                {usage.budget.daily.limitUsd ? ` of your ${usd(usage.budget.daily.limitUsd)} daily limit (resets at midnight)` : ""}.
              </p>
              {usage.budget.warnings.map((w) => (
                <div key={w} className="alert warning small">
                  {w}
                </div>
              ))}
              <button className="btn sm" onClick={() => (location.hash = "/main/provider")}>
                Details and limits
              </button>
            </>
          ) : (
            <p className="small muted">Loading…</p>
          )}
        </div>

        <div className="card">
          <h3>Updates</h3>
          <div className="row">
            <button
              className="btn"
              disabled={upd === "checking"}
              onClick={() => {
                setUpd("checking");
                void api.checkUpdates().then(setUpd, (e) => setUpd({ status: "error", message: errMsg(e), checkedAt: Date.now() }));
              }}
            >
              {upd === "checking" ? <span className="spinner" /> : null} Check for updates
            </button>
            <span className="small faint">Lumen checks only when you press this.</span>
          </div>
          {upd && upd !== "checking" && (
            <div className="small" style={{ marginTop: 8 }}>
              {upd.status === "disabled" && <div className="muted">{upd.message}</div>}
              {upd.status === "error" && <div className="alert error small">{upd.message}</div>}
              {upd.status === "up_to_date" && <div>You're on the latest version ({upd.current}).</div>}
              {upd.status === "available" && (
                <div className="col">
                  <div className={`alert ${upd.required ? "warning" : "info"} small`}>
                    Lumen {upd.latest} is available{upd.releasedAt ? ` (released ${upd.releasedAt})` : ""}. You have {upd.current}.
                    {upd.required ? " This version is no longer supported — please update." : ""}
                  </div>
                  {upd.notes && (
                    <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                      {upd.notes}
                    </pre>
                  )}
                  <div className="row">
                    <button className="btn primary" onClick={() => void api.openUpdate(upd.url)}>
                      Open download page
                    </button>
                  </div>
                  <div className="faint">
                    Download and install it like the first time. Your settings, sessions and data are kept: they live in Lumen's data folder, not in the app. Quit Lumen before installing.
                    {Object.keys(upd.sha256).length > 0 &&
                      ` To verify the download, compare its SHA-256 with: ${Object.entries(upd.sha256)
                        .map(([k, v]) => `${k} ${v}`)
                        .join("; ")}.`}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
