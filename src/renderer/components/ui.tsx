import { useEffect, useState, type ReactNode } from "react";
import type { ContextItemSummary } from "../../shared/types";
import { api, usd } from "../lib/api";
import type { UiMessage } from "../lib/hooks";
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

const KIND_ICON: Record<string, string> = {
  note: "✎",
  clipboard: "⧉",
  document: "▤",
  screenshot: "▣",
  transcript: "◉",
  knowledge: "✦",
  history: "↺",
};

export function ContextChips({ items, compact }: { items: ContextItemSummary[]; compact?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="overlay-context" aria-label="Active context">
      {items.map((i) => (
        <span key={i.id} className={`chip ${i.enabled ? "on" : ""} ${i.suspicious ? "warn" : ""}`} title={`${i.title}${i.preview ? `\n\n${i.preview}` : ""}${i.suspicious ? "\n\n⚠ Contains text that looks like instructions to the AI. It is treated as data only." : ""}`}>
          <button aria-label={`${i.enabled ? "Disable" : "Enable"} ${i.title}`} onClick={() => void api.updateContext(i.id, { enabled: !i.enabled })}>
            {KIND_ICON[i.kind]}
          </button>
          <span className="chip-label">{compact ? i.title.slice(0, 24) : i.title}</span>
          {i.pinned && <span aria-label="pinned">•</span>}
          <button aria-label={`Remove ${i.title}`} onClick={() => void api.removeContext(i.id)}>
            ×
          </button>
        </span>
      ))}
      {items.length > 1 && (
        <button className="btn ghost sm" onClick={() => void api.clearContext()}>
          Clear all
        </button>
      )}
    </div>
  );
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
          <span className="spinner" /> Thinking…
        </div>
      )}
      {m.content && (
        <div className="bubble">
          <Markdown text={m.content} refs={m.references} streaming={streaming} onCopy={onCopy} onLink={(u) => void api.openExternal(u)} />
        </div>
      )}
      {m.status === "error" && m.error && (
        <div className="alert error" role="alert">
          <div>{m.error.message}</div>
          {m.error.code === "missing_credentials" && (
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => void api.openMain("/main/provider")}>
              Open AI provider settings
            </button>
          )}
        </div>
      )}
      {m.status !== "streaming" && (
        <div className="msg-meta">
          {m.status === "cancelled" && <span className="badge warning">Stopped</span>}
          {m.meta?.isMock && <span className="badge warning">Mock</span>}
          {m.meta?.model && !m.meta.isMock && <span>{m.meta.model}</span>}
          {m.meta?.fallback && <span className="badge">answered by {m.meta.fallback}</span>}
          {m.meta?.ttftMs != null && <span>first token {m.meta.ttftMs} ms</span>}
          {m.meta?.costUsd ? <span>{usd(m.meta.costUsd)}</span> : null}
          <span className="spacer" />
          {m.content && (
            <button className="btn ghost sm" onClick={() => onCopy(m.content)}>
              Copy
            </button>
          )}
          {onRetry && (m.status !== "error" || m.error?.retryable || m.error?.code === "unknown") && (
            <button className="btn ghost sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {m.references.length > 0 && m.status === "done" && (
        <div className="refs" aria-label="Sources">
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

export function Toasts() {
  const [toasts, setToasts] = useState<{ id: number; level: string; message: string }[]>([]);
  useAppEvent((e) => {
    if (e.type !== "toast") return;
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, level: e.level, message: e.message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  });
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 1500);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg] as const;
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
