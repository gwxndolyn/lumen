import { useEffect, useState, type ReactNode } from "react";
import type { ContextItemSummary, ContextReference, ContextSource, ProviderHealth, SourceAvailability } from "../../shared/types";
import { STYLE_LABELS } from "../../shared/defaults";
import { api, errMsg, usd } from "../lib/api";
import type { LiveTranscript, UiMessage } from "../lib/hooks";
import { useAppEvent } from "../lib/hooks";
import { Markdown } from "../lib/markdown";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const KIND_ICON: Record<ContextSource, string> = {
  user_message: "✉",
  selected_text: "❝",
  note: "✎",
  clipboard: "⧉",
  document: "▤",
  screenshot: "▣",
  ocr: "▣",
  transcript: "◉",
  knowledge: "✦",
  history: "↺",
  memory: "◆",
};

function expiresIn(ts: number | null): string | null {
  if (ts === null) return null;
  const min = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  return min >= 60 ? `${Math.round(min / 60)}h` : `${min}m`;
}

const SOURCE_LABEL: Partial<Record<ContextSource, string>> = {
  selected_text: "Selected text",
  clipboard: "Clipboard",
  document: "Document",
  screenshot: "Screen capture",
  ocr: "Screen text",
  transcript: "Transcript",
  note: "Note",
};

function itemTooltip(i: ContextItemSummary) {
  const parts = [i.title];
  if (i.preview) parts.push(i.preview);
  if (i.confidence != null) parts.push(`OCR confidence ${Math.round(i.confidence * 100)}%`);
  if (i.sensitivity === "sensitive") parts.push(`Contains: ${i.sensitiveKinds.join(", ")}${"\n"}(masked before sending when redaction is on)`);
  if (i.suspicious) parts.push("⚠ Contains text that looks like instructions to the AI. It is treated as data only.");
  if (i.warning) parts.push(`⚠ ${i.warning}`);
  parts.push(`${SOURCE_LABEL[i.source] ?? i.source} · added ${new Date(i.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${i.enabled ? "" : " · turned off for answers"}`);
  const e = expiresIn(i.expiresAt);
  if (e) parts.push(`Expires in ${e}`);
  return parts.join("\n\n");
}

/** A capture awaiting confirmation: preview + OCR text, with explicit Use / Discard. */
function PendingCapture({ item }: { item: ContextItemSummary }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className="pending-capture" role="group" aria-label={`Review capture ${item.title}`}>
      {item.thumbnailDataUrl && <img src={item.thumbnailDataUrl} alt="" />}
      <div className="col grow" style={{ gap: 4 }}>
        <div className="row small">
          <strong className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.title}
          </strong>
          {item.sensitivity === "sensitive" && <span className="badge warning">Sensitive: {item.sensitiveKinds.join(", ")}</span>}
        </div>
        <div className="small muted">
          {item.ocr === "running" ? (
            <span className="row">
              <span className="spinner" /> Reading text on-device…
            </span>
          ) : item.ocr === "failed" ? (
            item.warning
          ) : item.ocr === "done" ? (
            <button className="link" onClick={() => setShowText((v) => !v)}>
              {item.chars ? `${item.chars} characters recognized` : "No text recognized"}
              {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}
            </button>
          ) : (
            "Image only (text recognition off)"
          )}
        </div>
        {showText && <pre className="ocr-preview">{item.preview}</pre>}
        <div className="row">
          <button className="btn primary sm" data-action="confirm-capture" onClick={() => void api.confirmContext(item.id)}>
            Use this capture
          </button>
          <button className="btn ghost sm" onClick={() => void api.removeContext(item.id)}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContextChips({ items, compact }: { items: ContextItemSummary[]; compact?: boolean }) {
  if (!items.length) return null;
  const pending = items.filter((i) => i.status === "pending");
  const active = items.filter((i) => i.status === "active");
  return (
    <div className="col" style={{ gap: 6 }}>
      {pending.map((i) => (
        <PendingCapture key={i.id} item={i} />
      ))}
      {active.length > 0 && (
        <div className="overlay-context" aria-label="Active context">
          {active.map((i) => (
            <span
              key={i.id}
              role="group"
              aria-label={`${SOURCE_LABEL[i.source] ?? i.source}: ${i.title}${i.enabled ? "" : " (off)"}`}
              className={`chip ${i.enabled ? "on" : ""} ${i.suspicious || i.warning ? "warn" : ""}`}
              title={itemTooltip(i)}
            >
              <button aria-label={`${i.enabled ? "Disable" : "Enable"} ${i.title}`} aria-pressed={i.enabled} onClick={() => void api.updateContext(i.id, { enabled: !i.enabled })}>
                {i.ocr === "running" ? <span className="spinner" style={{ width: 10, height: 10 }} /> : KIND_ICON[i.source]}
              </button>
              <span className="chip-label">{compact ? i.title.slice(0, 24) : i.title}</span>
              {i.sensitivity === "sensitive" && <span aria-label="sensitive">⚑</span>}
              {i.expiresAt && !i.pinned && <span className="faint small">{expiresIn(i.expiresAt)}</span>}
              <button
                aria-label={i.pinned ? `Unpin ${i.title}` : `Pin ${i.title}`}
                title={i.pinned ? "Pinned — won't expire" : "Pin (keep until removed)"}
                onClick={() => void api.updateContext(i.id, { pinned: !i.pinned })}
              >
                {i.pinned ? "●" : "○"}
              </button>
              <button aria-label={`Remove ${i.title}`} onClick={() => void api.removeContext(i.id)}>
                ×
              </button>
            </span>
          ))}
          {active.length > 1 && (
            <button className="btn ghost sm" onClick={() => void api.clearContext()}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Explains, in the UI, which sources were missing for this answer. */
function AvailabilityNote({ a }: { a: SourceAvailability }) {
  const used: string[] = [];
  if (a.transcript === "live") used.push("transcript");
  if (a.screen) used.push(`${a.screen} screen`);
  if (a.documents) used.push(`${a.documents} doc`);
  if (a.notes) used.push(`${a.notes} note`);
  if (a.knowledge) used.push(`${a.knowledge} knowledge`);
  if (a.history) used.push(`${a.history} earlier`);
  return <span className="faint">{used.length ? `Context: ${used.join(" · ")}` : "No context — general answer"}</span>;
}

export function MessageView({ m, onRetry, onCopy }: { m: UiMessage; onRetry?: () => void; onCopy: (t: string) => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        {m.label && <span className="msg-label">{m.label}</span>}
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  const streaming = m.status === "streaming";
  return (
    <div className="msg assistant" aria-live={streaming ? "polite" : undefined} aria-busy={streaming}>
      {m.warnings?.map((w) => (
        <div key={w} className="alert warning small">
          ⚠ {w}
        </div>
      ))}
      {m.meta?.isMock && streaming && !m.content && <div className="small faint">Development mode — mock provider</div>}
      {m.retryNote && (
        <div className="row small muted">
          <span className="spinner" /> {m.retryNote}
        </div>
      )}
      {streaming && !m.content && !m.retryNote && (
        <div className="row small muted">
          <span className="spinner" /> {m.availability ? "Thinking…" : "Preparing context…"}
        </div>
      )}
      {m.content && (
        <div className="bubble selectable">
          <Markdown text={m.content} refs={m.references} streaming={streaming} onCopy={onCopy} onLink={(u) => void api.openExternal(u)} />
        </div>
      )}
      {m.status !== "streaming" && m.meta?.verification?.findings.some((f) => f.severity === "warn") && (
        <div className="alert warning small" role="note" aria-label="Answer checks">
          {m.meta.verification.findings
            .filter((f) => f.severity === "warn" && f.check !== "truncated")
            .map((f) => (
              <div key={f.check}>⚠ {f.message}</div>
            ))}
        </div>
      )}
      {m.status === "done" && m.meta?.stopReason === "max_tokens" && (
        <div className="alert warning small">This answer was cut off at the output limit. Ask “continue”, or raise Max output tokens in AI provider settings.</div>
      )}
      {m.status === "error" && m.error && (
        <div className="alert error" role="alert">
          <div>{m.error.message}</div>
          <div className="row" style={{ marginTop: 6 }}>
            {m.error.code === "spend_limit" && (
              <button className="btn sm" onClick={() => void api.openMain("/main/provider")}>
                Adjust spend limit
              </button>
            )}
            {(m.error.code === "missing_credentials" || m.error.code === "auth") && (
              <button className="btn sm" onClick={() => void api.openMain("/main/provider")}>
                Open AI provider settings
              </button>
            )}
            {onRetry && m.error.retryable && (
              <button className="btn sm" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}
      {m.status !== "streaming" && m.status !== "error" && (
        <div className="msg-meta">
          {m.status === "cancelled" && <span className="badge warning">Stopped</span>}
          {m.status === "interrupted" && (
            <span className="badge warning" title="The connection failed partway through; this is the text that arrived before it did.">
              Incomplete
            </span>
          )}
          {m.meta?.isMock && <span className="badge warning">Mock</span>}
          {m.meta?.style && m.meta.style !== "quick" && <span className="badge">{STYLE_LABELS[m.meta.style]}</span>}
          {m.meta?.intent && (
            <span className="badge" title="How Lumen understood this message (rule-based). Ask again with different wording if it's wrong.">
              {m.meta.intent.ambiguous ? "Needs clarification" : m.meta.intent.label}
            </span>
          )}
          {m.meta?.model && !m.meta.isMock && (
            <span title={m.meta.routedFrom ? `Economy routing used this model instead of ${m.meta.routedFrom}` : undefined}>
              {m.meta.model}
              {m.meta.routedFrom ? " (economy)" : ""}
            </span>
          )}
          {m.meta?.verification && (
            <span
              className="faint"
              title={
                (m.meta.verification.findings.map((f) => f.message).join("\n") || "All automatic answer checks passed.") +
                "\nThese are rule-based checks of the answer text, not a proof it is correct."
              }
            >
              {m.meta.verification.findings.length
                ? `${m.meta.verification.findings.length} check note${m.meta.verification.findings.length > 1 ? "s" : ""}`
                : `${m.meta.verification.checksRun} checks ✓`}
            </span>
          )}
          {m.meta?.verification?.code && <CodeCheckBadge checks={m.meta.verification.code} />}
          {m.meta?.fallback && <span className="badge">answered by {m.meta.fallback}</span>}
          {m.meta?.ttftMs != null && <span>first token {m.meta.ttftMs} ms</span>}
          {m.meta?.costUsd ? <span>{usd(m.meta.costUsd)}</span> : null}
          {m.availability && <AvailabilityNote a={m.availability} />}
          <span className="spacer" />
          {m.content && (
            <button className="btn ghost sm" onClick={() => onCopy(m.content)}>
              Copy
            </button>
          )}
          {onRetry && (
            <button className="btn ghost sm" onClick={onRetry}>
              Retry
            </button>
          )}
          {m.status === "done" && !m.meta?.isMock && <FeedbackButton messageId={m.id} />}
          {m.status === "done" && !m.meta?.isMock && (
            <button className="btn ghost sm" title="Write a beta report about this answer (you choose what it includes)" onClick={() => void api.openMain(`/main/report?answer=${m.id}`)}>
              Report
            </button>
          )}
        </div>
      )}
      {m.status !== "streaming" && m.selection && <ContextInspector m={m} />}
      {m.references.length > 0 && m.status === "done" && (
        <div className="refs" aria-label="Sources cited">
          <span className="small faint">Sources:</span>
          {m.references.map((r) => (
            <span key={r.label} className="ref" title={r.excerpt}>
              {r.label} · {r.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const FEEDBACK_OPTIONS: { kind: "helpful" | "incorrect" | "incomplete" | "irrelevant_context" | "too_slow" | "too_verbose" | "bad_formatting" | "other"; label: string }[] = [
  { kind: "helpful", label: "Helpful" },
  { kind: "incorrect", label: "Incorrect" },
  { kind: "incomplete", label: "Incomplete" },
  { kind: "irrelevant_context", label: "Irrelevant context" },
  { kind: "too_slow", label: "Too slow" },
  { kind: "too_verbose", label: "Too verbose" },
  { kind: "bad_formatting", label: "Incorrect formatting" },
  { kind: "other", label: "Other" },
];

/**
 * Optional feedback on one answer. Stored only on this computer, with the answer's metadata
 * (task type, model, timings) — not the question, answer or context. Manage it in Diagnostics → Quality.
 */
function FeedbackButton({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof FEEDBACK_OPTIONS)[number]["kind"] | null>(null);
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState("");
  const [state, setState] = useState<"idle" | "saved" | string>("idle");
  if (state === "saved") return <span className="small faint">Thanks — saved locally</span>;
  const send = (k: NonNullable<typeof kind>) =>
    void api
      .addFeedback({ messageId, kind: k, note: note || undefined, expected: expected || undefined })
      .then(() => setState("saved"))
      .catch((e) => setState(errMsg(e)));
  return (
    <span style={{ position: "relative" }}>
      <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)} title="Rate this answer (stored only on this computer)">
        Feedback
      </button>
      {open && (
        <div className="card" role="dialog" aria-label="Answer feedback" style={{ position: "absolute", right: 0, bottom: "110%", width: 320, zIndex: 20, padding: 12 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            {FEEDBACK_OPTIONS.map((o) => (
              <button key={o.kind} className={`btn sm ${kind === o.kind ? "primary" : ""}`} aria-pressed={kind === o.kind} onClick={() => (o.kind === "helpful" ? send("helpful") : setKind(o.kind))}>
                {o.label}
              </button>
            ))}
          </div>
          {kind && (
            <div className="col" style={{ marginTop: 8 }}>
              <textarea
                className="textarea"
                rows={2}
                maxLength={2000}
                aria-label="What was wrong (optional)"
                placeholder="What was wrong? (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {(kind === "incorrect" || kind === "incomplete") && (
                <textarea
                  className="textarea"
                  rows={2}
                  maxLength={4000}
                  aria-label="Expected answer (optional)"
                  placeholder="What should it have said? (optional)"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              )}
              <div className="small faint">Saved on this computer only, with the answer's task type, model and timings — not the question, answer or context. Secrets you type are masked.</div>
              <div className="row">
                <button className="btn sm primary" onClick={() => send(kind)}>
                  Save feedback
                </button>
                <button className="btn sm ghost" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {state !== "idle" && <div className="alert error small">{state}</div>}
        </div>
      )}
    </span>
  );
}

/**
 * Per-block syntax results. Wording is deliberate: "parses" (never "works" or "tested"), and
 * languages Lumen can't parse are listed as not checked rather than omitted.
 */
function CodeCheckBadge({ checks }: { checks: NonNullable<NonNullable<UiMessage["meta"]>["verification"]>["code"] & object }) {
  const failed = checks.filter((c) => c.status === "failed");
  const passed = checks.filter((c) => c.status === "passed");
  const label = failed.length ? `Syntax error in ${failed.length} code block${failed.length > 1 ? "s" : ""}` : passed.length ? `Code parses (${passed.length}/${checks.length})` : "Code not checked";
  const title = [
    ...checks.map((c) => `Block ${c.block + 1} (${c.lang}): ${c.status} — ${c.method}${c.detail ? `: ${c.detail}` : ""}`),
    "Lumen checks syntax only. It never runs code, so it can't tell whether the code is correct.",
  ].join("\n");
  return (
    <span className={`badge ${failed.length ? "danger" : ""}`} title={title}>
      {label}
    </span>
  );
}

const WHY_LABEL: Record<NonNullable<ContextReference["why"]>, string> = { pinned: "pinned by you", attached: "attached to this session", matched: "matched your question", recent: "recent" };

/** What was sent with this answer and why — counts and titles only. */
function ContextInspector({ m }: { m: UiMessage }) {
  const s = m.selection!;
  const sent = m.sent ?? [];
  const cited = new Set(m.references.map((r) => r.label));
  return (
    <details className="small" style={{ marginTop: 4 }}>
      <summary className="faint" style={{ cursor: "pointer" }}>
        Context used: {s.included} of {s.considered} available source{s.considered === 1 ? "" : "s"}
        {s.droppedForBudget ? ` · ${s.droppedForBudget} cut for size` : ""}
      </summary>
      <div className="col" style={{ gap: 2, padding: "6px 0 2px 12px" }}>
        {sent.length === 0 && <div className="muted">No context was sent; this was answered from the question alone.</div>}
        {sent.map((r) => (
          <div key={r.label} className="row" style={{ gap: 6 }}>
            <span className="mono">{r.label}</span>
            <span>{r.title}</span>
            <span className="faint">
              {r.kind.replace("_", " ")} · {r.why ? WHY_LABEL[r.why] : ""}
              {cited.has(r.label) ? " · cited" : ""}
            </span>
          </div>
        ))}
        <div className="faint">
          {s.belowRelevance ? `${s.belowRelevance} source${s.belowRelevance === 1 ? " was" : "s were"} left out as not relevant. ` : ""}
          {Math.round(s.contextChars / 100) / 10}k of {s.budgetChars / 1000}k characters of context budget used.
        </div>
      </div>
    </details>
  );
}

const HEALTH_DOT: Record<ProviderHealth["state"], string> = { ok: "ok", degraded: "warn", down: "err", unconfigured: "err", mock: "warn", unknown: "" };

export function ProviderStatus({ health, compact }: { health: ProviderHealth | null; compact?: boolean }) {
  if (!health) return null;
  const label =
    health.state === "mock"
      ? "Dev mode"
      : health.state === "unconfigured"
        ? "No API key"
        : health.state === "down"
          ? "Provider error"
          : health.state === "degraded"
            ? "Provider issues"
            : compact
              ? ""
              : health.model;
  return (
    <button className="status-pill no-drag" title={`${health.kind} · ${health.model}\n${health.message}`} onClick={() => void api.openMain("/main/provider")}>
      <span className={`dot ${HEALTH_DOT[health.state]}`} />
      {label && <span>{label}</span>}
    </button>
  );
}

/** Recording controls that are always reachable while audio is active. */
export function RecordingControls({ live, compact }: { live: LiveTranscript; compact?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  if (!["recording", "paused", "reconnecting", "connecting"].includes(live.status)) return null;
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => setErr(errMsg(e)));
  return (
    <span className="rec-pill" title={err ?? live.detail ?? (live.elsewhere ? "Recording in another session" : undefined)} role="status">
      <span className={`dot ${live.status === "recording" ? "rec" : "warn"}`} />
      {live.status === "recording" ? "REC" : live.status === "paused" ? "Paused" : live.status === "connecting" ? "Connecting" : "Reconnecting"}
      {!compact && live.audio?.systemAudio === "active" && <span title="System audio included">+sys</span>}
      {!compact && live.audio && (
        <span className="level" aria-label="Input level">
          <span style={{ width: `${Math.round(live.audio.micLevel * 100)}%` }} />
        </span>
      )}
      {live.status === "paused" ? (
        <button className="btn ghost sm no-drag" onClick={() => run(() => api.transcriptResume())} aria-label="Resume recording">
          ▶
        </button>
      ) : (
        <button className="btn ghost sm no-drag" onClick={() => run(() => api.transcriptPause())} aria-label="Pause recording">
          ❚❚
        </button>
      )}
      <button className="btn ghost sm no-drag" onClick={() => run(() => api.transcriptStop())} aria-label="Stop recording">
        ■
      </button>
    </span>
  );
}

const localToasts = new Set<(level: "info" | "error", message: string) => void>();
/** Show a toast from the renderer (same stack as main-process toasts). */
export function showToast(message: string, level: "info" | "error" = "info") {
  for (const f of localToasts) f(level, message);
}

export function Toasts() {
  const [toasts, setToasts] = useState<{ id: number; level: string; message: string }[]>([]);
  const push = (level: string, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, level, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };
  useEffect(() => {
    localToasts.add(push);
    return () => void localToasts.delete(push);
  }, []);
  useAppEvent((e) => {
    if (e.type !== "toast") return;
    push(e.level, e.message);
  });
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="grow">{t.message}</span>
          <button className="btn ghost sm" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function useTheme(theme: "dark" | "light" | "system" | undefined) {
  useEffect(() => {
    const apply = () => {
      const t = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : (theme ?? "dark");
      document.documentElement.dataset.theme = t;
    };
    apply();
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

/** Run an async action, surfacing its error message. */
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      setError(errMsg(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}
