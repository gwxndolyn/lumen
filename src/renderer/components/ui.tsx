import { useEffect, useState, type ReactNode } from "react";
import type { ContextItemSummary, ContextSource, ProviderHealth, SourceAvailability } from "../../shared/types";
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
};

function expiresIn(ts: number | null): string | null {
  if (ts === null) return null;
  const min = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  return min >= 60 ? `${Math.round(min / 60)}h` : `${min}m`;
}

function itemTooltip(i: ContextItemSummary) {
  const parts = [i.title];
  if (i.preview) parts.push(i.preview);
  if (i.confidence != null) parts.push(`OCR confidence ${Math.round(i.confidence * 100)}%`);
  if (i.sensitivity === "sensitive") parts.push(`Contains: ${i.sensitiveKinds.join(", ")}${"\n"}(masked before sending when redaction is on)`);
  if (i.suspicious) parts.push("⚠ Contains text that looks like instructions to the AI. It is treated as data only.");
  if (i.warning) parts.push(`⚠ ${i.warning}`);
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
              className={`chip ${i.enabled ? "on" : ""} ${i.suspicious || i.warning ? "warn" : ""}`}
              title={itemTooltip(i)}
            >
              <button aria-label={`${i.enabled ? "Disable" : "Enable"} ${i.title}`} aria-pressed={i.enabled} onClick={() => void api.updateContext(i.id, { enabled: !i.enabled })}>
                {i.ocr === "running" ? <span className="spinner" style={{ width: 10, height: 10 }} /> : KIND_ICON[i.source]}
              </button>
              <span className="chip-label">{compact ? i.title.slice(0, 24) : i.title}</span>
              {i.sensitivity === "sensitive" && <span aria-label="sensitive">⚑</span>}
              {i.expiresAt && !i.pinned && <span className="faint small">{expiresIn(i.expiresAt)}</span>}
              <button aria-label={i.pinned ? `Unpin ${i.title}` : `Pin ${i.title}`} title={i.pinned ? "Pinned — won't expire" : "Pin (keep until removed)"} onClick={() => void api.updateContext(i.id, { pinned: !i.pinned })}>
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
      {m.status === "error" && m.error && (
        <div className="alert error" role="alert">
          <div>{m.error.message}</div>
          <div className="row" style={{ marginTop: 6 }}>
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
          {m.meta?.isMock && <span className="badge warning">Mock</span>}
          {m.meta?.style && m.meta.style !== "quick" && <span className="badge">{STYLE_LABELS[m.meta.style]}</span>}
          {m.meta?.model && !m.meta.isMock && <span>{m.meta.model}</span>}
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
        </div>
      )}
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

const HEALTH_DOT: Record<ProviderHealth["state"], string> = { ok: "ok", degraded: "warn", down: "err", unconfigured: "err", mock: "warn", unknown: "" };

export function ProviderStatus({ health, compact }: { health: ProviderHealth | null; compact?: boolean }) {
  if (!health) return null;
  const label =
    health.state === "mock" ? "Dev mode" : health.state === "unconfigured" ? "No API key" : health.state === "down" ? "Provider error" : health.state === "degraded" ? "Provider issues" : compact ? "" : health.model;
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

export function Toasts() {
  const [toasts, setToasts] = useState<{ id: number; level: string; message: string }[]>([]);
  useAppEvent((e) => {
    if (e.type !== "toast") return;
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, level: e.level, message: e.message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
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
