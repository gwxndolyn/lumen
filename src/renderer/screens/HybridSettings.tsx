import { useEffect, useState } from "react";
import type { BudgetStatus, CacheStats, EmbeddingIndexState, LoadedModel, LocalState, UsageRow } from "../../shared/api";
import type { Settings } from "../../shared/types";
import { api, errMsg, formatTime, usd } from "../lib/api";
import { Segmented, Switch } from "../components/ui";

type Props = { settings: Settings; update: (p: unknown) => Promise<void> };
type Status = LocalState & { embeddingIndex: EmbeddingIndexState };

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const BASIS: Record<string, string> = { list_price: "list price (estimate)", user_price: "your price (estimate)", local: "local — no API cost", none: "no price known" };

/** Local runtime, hybrid routing, privacy restriction, usage limits and caches. Lives in AI provider settings. */
export function HybridSettings({ settings, update }: Props) {
  const inf = settings.inference;
  const lim = settings.limits;
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [checking, setChecking] = useState(false);
  const [usage, setUsage] = useState<{ rows: UsageRow[]; budget: BudgetStatus } | null>(null);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const check = () => {
    setChecking(true);
    void api
      .localStatus()
      .then((s) => {
        setStatus(s);
        if (s.status?.available) void api.localLoaded().then(setLoaded);
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setChecking(false));
  };
  const loadUsage = () => {
    void api.usageReport(30).then(setUsage);
    void api.cacheStats().then(setCache);
  };
  useEffect(() => {
    loadUsage();
    // Only probe the loopback runtime when local inference is actually configured.
    if (settings.provider.kind === "ollama" || inf.mode !== "manual" || inf.local.model || inf.local.embeddingModel) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (patch: unknown) => void update(patch).catch((e) => setError(errMsg(e)));

  const models = status?.status?.models ?? [];
  const chatModels = models;
  const runtimeUp = !!status?.status?.available;

  return (
    <>
      {error && (
        <div className="alert error small" role="alert" style={{ marginTop: 12 }}>
          {error}{" "}
          <button className="btn sm ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="alert info small" role="status" style={{ marginTop: 12 }}>
          {notice}
        </div>
      )}

      <div className="card">
        <h3>Local model (Ollama)</h3>
        <p className="small muted">
          Runs a language model on this computer, so questions answered locally never leave it. Lumen only talks to Ollama on this machine and never downloads models: you install Ollama (ollama.com)
          and pull a model yourself, e.g. <span className="mono">ollama pull llama3.2</span> (≈2 GB, needs ~4 GB free memory). 7–8B models (≈5 GB) need about 8 GB of free memory; larger ones need 16
          GB+. Without a GPU or Apple Silicon, expect several seconds per answer. Small local models are noticeably weaker than cloud models on coding and reasoning — compare them in the Evaluation
          Lab before relying on them.
        </p>
        <div className="field">
          <div>
            <label htmlFor="ol-url">Runtime address</label>
            <div className="hint">Must be on this computer (127.0.0.1, localhost or [::1]).</div>
          </div>
          <div className="row">
            <input
              id="ol-url"
              className="input"
              defaultValue={inf.local.baseUrl}
              onBlur={(e) => e.target.value !== inf.local.baseUrl && set({ inference: { local: { baseUrl: e.target.value.trim() } } })}
            />
            <button className="btn" disabled={checking} onClick={check}>
              {checking ? "Checking…" : "Check"}
            </button>
          </div>
        </div>
        {status && (
          <div className={`alert ${runtimeUp ? "info" : "warning"} small`} style={{ margin: "8px 0" }}>
            {runtimeUp
              ? `Ollama ${status.status?.version ?? ""} is running · ${models.length} model${models.length === 1 ? "" : "s"} installed · checked ${formatTime(status.status!.checkedAt)}.`
              : `Not available: ${status.status?.error ?? "not checked"}.`}
            {status.problem && runtimeUp && <div>Selected model: {status.problem}.</div>}
          </div>
        )}
        <div className="field">
          <div>
            <label htmlFor="ol-model">Chat model</label>
            <div className="hint">Installed models only.</div>
          </div>
          <select
            id="ol-model"
            className="select"
            value={inf.local.model}
            onChange={(e) => (set({ inference: { local: { model: e.target.value } } }), setTimeout(check, 50))}
            disabled={!runtimeUp && !inf.local.model}
          >
            <option value="">None</option>
            {inf.local.model && !chatModels.some((m) => m.name === inf.local.model || m.name === `${inf.local.model}:latest`) && (
              <option value={inf.local.model}>{inf.local.model} (not installed)</option>
            )}
            {chatModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {m.parameterSize ?? "?"} · {gb(m.sizeBytes)}
              </option>
            ))}
          </select>
        </div>
        {status?.model && (
          <dl className="kv" style={{ margin: "6px 0 10px" }}>
            <dt>Capabilities (reported by Ollama)</dt>
            <dd>{status.model.capabilities.join(", ")}</dd>
            <dt>Model context length</dt>
            <dd>{status.model.contextLength ? `${status.model.contextLength.toLocaleString()} tokens` : "unknown"}</dd>
            <dt>Vision</dt>
            <dd>{status.model.capabilities.includes("vision") ? "yes" : "no — screen captures contribute OCR text only"}</dd>
          </dl>
        )}
        <div className="field">
          <div>
            <label htmlFor="ol-ctx">Context size</label>
            <div className="hint">
              Tokens Lumen asks the runtime to allocate. More context needs more memory; requests that don't fit are refused (or routed to the cloud in Local first) instead of being silently cut.
            </div>
          </div>
          <select id="ol-ctx" className="select" value={inf.local.numCtx} onChange={(e) => set({ inference: { local: { numCtx: Number(e.target.value) } } })}>
            {[4096, 8192, 16384, 32768, 65536].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} tokens
              </option>
            ))}
          </select>
        </div>
        {loaded.length > 0 && (
          <div className="small muted">Loaded in memory now: {loaded.map((m) => `${m.name} (${gb(m.sizeBytes)}${m.vramBytes ? `, ${gb(m.vramBytes)} on GPU` : ""})`).join(", ")}</div>
        )}
      </div>

      <div className="card">
        <h3>Routing</h3>
        <div className="field">
          <div>
            <div className="label">Mode</div>
            <div className="hint">
              <strong>Manual</strong>: always the provider selected above. <strong>Local first</strong>: the local model, except deep coding/design work or requests it can't handle (images, too
              large), which go to the cloud provider. <strong>Cloud first</strong>: the cloud provider; the local model when the cloud is unavailable or privacy rules keep the content on this device.
              Each answer shows where it ran.
            </div>
          </div>
          <Segmented
            label="Routing mode"
            value={inf.mode}
            options={[
              { value: "manual", label: "Manual" },
              { value: "local_first", label: "Local first" },
              { value: "cloud_first", label: "Cloud first" },
            ]}
            onChange={(v) => set({ inference: { mode: v } })}
          />
        </div>
        <div className="field">
          <div>
            <div className="label">If the cloud provider fails, use the local model</div>
            <div className="hint">Keeps data on this device. Only before any text was shown.</div>
          </div>
          <Switch label="Cloud to local fallback" checked={inf.fallback.cloudToLocal} onChange={(v) => set({ inference: { fallback: { cloudToLocal: v } } })} />
        </div>
        <div className="field">
          <div>
            <div className="label">If the local model fails, use the cloud provider</div>
            <div className="hint">Off by default: it sends the request off this device. Privacy restriction below still applies.</div>
          </div>
          <Switch label="Local to cloud fallback" checked={inf.fallback.localToCloud} onChange={(v) => set({ inference: { fallback: { localToCloud: v } } })} />
        </div>
      </div>

      <div className="card">
        <h3>Privacy restriction</h3>
        <div className="field">
          <div>
            <div className="label">Keep protected context on this device</div>
            <div className="hint">
              Screen content (captures, OCR, selected text, clipboard), transcripts and documents/knowledge are only sent to a cloud provider for the kinds you allow below. Otherwise they're answered
              by the local model, or Lumen tells you why it can't answer. This applies in every routing mode, including Manual.
            </div>
          </div>
          <Switch label="Privacy restriction" checked={inf.privacyRestricted} onChange={(v) => set({ inference: { privacyRestricted: v } })} />
        </div>
        {inf.privacyRestricted &&
          (["screen", "transcript", "documents"] as const).map((k) => (
            <div className="field" key={k}>
              <div className="label">Allow sending {k === "screen" ? "screen content" : k === "transcript" ? "transcripts" : "documents and knowledge"} to the cloud</div>
              <Switch label={`Allow ${k} to cloud`} checked={inf.cloudAllowed[k]} onChange={(v) => set({ inference: { cloudAllowed: { [k]: v } } })} />
            </div>
          ))}
      </div>

      <div className="card">
        <h3>Usage limits</h3>
        {usage?.budget.warnings.map((w) => (
          <div key={w} className="alert warning small" style={{ marginBottom: 8 }}>
            {w}
          </div>
        ))}
        <NumberField
          label="Cost per session"
          hint="Estimated USD for the active workspace session; 0 = no limit. Checked against the worst case before each request."
          value={lim.costPerSessionUsd}
          step={0.1}
          min={0}
          max={10000}
          onCommit={(v) => set({ limits: { costPerSessionUsd: v } })}
        />
        <NumberField
          label="Requests per session"
          hint="0 = no limit. Counts local requests too."
          value={lim.requestsPerSession}
          min={0}
          max={100000}
          onCommit={(v) => set({ limits: { requestsPerSession: Math.round(v) } })}
        />
        <NumberField
          label="Warn at"
          hint="Show a warning when a budget reaches this share."
          value={lim.warnAtPercent}
          min={10}
          max={100}
          suffix="%"
          onCommit={(v) => set({ limits: { warnAtPercent: Math.round(v) } })}
        />
        <NumberField
          label="Concurrent requests"
          hint="Answers generating at the same time."
          value={lim.maxConcurrentRequests}
          min={1}
          max={10}
          onCommit={(v) => set({ limits: { maxConcurrentRequests: Math.round(v) } })}
        />
        <NumberField
          label="Max context per question"
          hint="Characters of context sent with one question (4,000–200,000)."
          value={lim.maxContextChars}
          min={4000}
          max={200000}
          suffix="chars"
          onCommit={(v) => set({ limits: { maxContextChars: Math.round(v) } })}
        />
        <NumberField
          label="Attempts per request"
          hint="Including the first. Retries happen only for transient errors and never after text was shown."
          value={lim.maxAttempts}
          min={1}
          max={6}
          onCommit={(v) => set({ limits: { maxAttempts: Math.round(v) } })}
        />
        <div className="field">
          <div>
            <div className="label">Retry after a timeout</div>
            <div className="hint">Off by default: a request that timed out may still have been processed and billed, so resending it can double the cost.</div>
          </div>
          <Switch label="Retry timeouts" checked={lim.retryTimeouts} onChange={(v) => set({ limits: { retryTimeouts: v } })} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Usage (last 30 days)</h3>
          <span className="spacer" />
          <button className="btn sm" onClick={loadUsage}>
            Refresh
          </button>
        </div>
        {usage && (
          <p className="small muted">
            Today ≈ {usd(usage.budget.daily.spentUsd)} across {usage.budget.daily.requests} requests · this session ≈ {usd(usage.budget.session.spentUsd)} across {usage.budget.session.requests}. Token
            counts are reported by the provider; costs are estimates from list prices and exclude anything Lumen has no price for.
          </p>
        )}
        {usage && usage.rows.length === 0 && <p className="small muted">No requests recorded yet.</p>}
        {usage && usage.rows.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Provider · model</th>
                <th>Task</th>
                <th>Outcome</th>
                <th>Requests</th>
                <th>Tokens in / out</th>
                <th>Cost</th>
                <th>Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.provider ?? "—"} · {r.model}
                  </td>
                  <td>{r.category ?? "—"}</td>
                  <td>{r.outcome}</td>
                  <td>{r.requests}</td>
                  <td>
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </td>
                  <td title={BASIS[r.costBasis] ?? r.costBasis}>{r.costBasis === "none" ? "unknown" : r.costBasis === "local" ? "—" : `≈ ${usd(r.costUsd)}`}</td>
                  <td>{r.avgLatencyMs == null ? "—" : `${r.avgLatencyMs} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Caching</h3>
        <div className="field">
          <div>
            <div className="label">Reuse identical answers</div>
            <div className="hint">
              When the question, every piece of context, the model and settings are exactly the same, show the previous answer instead of asking again (for 10 minutes). Kept in memory only, never on
              disk; cleared on restart.
            </div>
          </div>
          <Switch label="Response cache" checked={inf.responseCache} onChange={(v) => set({ inference: { responseCache: v } })} />
        </div>
        {cache && (
          <div className="row small muted" style={{ flexWrap: "wrap" }}>
            {cache.entries} cached · {cache.hits} hits / {cache.misses} misses
            {cache.hits + cache.misses > 0 ? ` (${Math.round((cache.hits / (cache.hits + cache.misses)) * 100)}% hit rate)` : ""}
            {cache.savedMsP50 != null ? ` · median time saved per hit ${Math.round(cache.savedMsP50)} ms` : ""}
            <button
              className="btn sm"
              onClick={() =>
                void api.cacheClear().then(() => {
                  setNotice("Response cache cleared.");
                  loadUsage();
                })
              }
            >
              Clear cache
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Semantic knowledge search (optional)</h3>
        <p className="small muted">
          Keyword search always works. With a local embedding model (e.g. <span className="mono">ollama pull nomic-embed-text</span>, ≈270 MB), Lumen can also find passages that use different words.
          Vectors are computed on this computer and stored in Lumen's database; they are deleted with their documents.
        </p>
        <div className="field">
          <label htmlFor="emb-model">Embedding model</label>
          <select id="emb-model" className="select" value={inf.local.embeddingModel} onChange={(e) => set({ inference: { local: { embeddingModel: e.target.value } } })}>
            <option value="">None (keyword search only)</option>
            {inf.local.embeddingModel && !models.some((m) => m.name === inf.local.embeddingModel) && <option value={inf.local.embeddingModel}>{inf.local.embeddingModel}</option>}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        {status && inf.local.embeddingModel && (
          <>
            <div className="small muted" style={{ marginBottom: 8 }}>
              Index: {status.embeddingIndex.indexed} of {status.embeddingIndex.totalChunks} passages
              {status.embeddingIndex.model ? ` · built with ${status.embeddingIndex.model} (${status.embeddingIndex.dims} dimensions)` : ""}
              {status.embeddingIndex.stale && " · built with a different model — rebuild before it can be used"}
            </div>
            <div className="row">
              <button
                className="btn"
                disabled={indexing || !runtimeUp}
                onClick={() => {
                  setIndexing(true);
                  void api
                    .localBuildIndex(status.embeddingIndex.stale)
                    .then((r) => setNotice(`Indexed ${r.added} passages.`))
                    .catch((e) => setError(errMsg(e)))
                    .finally(() => (setIndexing(false), check()));
                }}
              >
                {indexing ? "Indexing…" : status.embeddingIndex.stale ? "Rebuild index" : "Update index"}
              </button>
              {indexing && (
                <button className="btn" onClick={() => void api.localStopIndex()}>
                  Stop
                </button>
              )}
              <button className="btn danger" disabled={indexing} onClick={() => void api.localClearIndex().then(check)}>
                Delete index
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function NumberField({
  label,
  hint,
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  hint: string;
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <div className="field">
      <div>
        <div className="label">{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <div className="row">
        <input
          className="input"
          style={{ width: 120 }}
          type="number"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        {suffix && <span className="small muted">{suffix}</span>}
      </div>
    </div>
  );
}
