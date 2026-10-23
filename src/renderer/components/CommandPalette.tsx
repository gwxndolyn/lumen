import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveScreenState, SessionSummary, Settings } from "../../shared/types";
import { MODE_LABELS, PROVIDER_INFO } from "../../shared/defaults";
import { api, errMsg, prettyAccelerator } from "../lib/api";
import { onceGuard, rankCommands, type Command } from "../lib/commands";
import { isRecordingStatus, type LiveTranscript } from "../lib/hooks";

/** Commands that exist and apply right now. Every entry calls a real API or route. */
export function buildCommands(ctx: {
  settings: Settings;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  live: Pick<LiveTranscript, "status">;
  liveScreen: LiveScreenState | null;
  latestAnswer: string | null;
  go: (route: string) => void;
  notify: (msg: string) => void;
}): Command[] {
  const { settings: s, go } = ctx;
  const out: Command[] = [
    {
      id: "session.new",
      title: "New session",
      section: "Session",
      keywords: "start create",
      run: async () => {
        await api.createSession({ title: `Session ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, type: s.assistant.mode });
        go("assistant");
      },
    },
    { id: "session.manage", title: "Manage sessions…", section: "Session", keywords: "rename delete clear", run: () => go("sessions") },
    { id: "history.search", title: "Search conversation history", section: "Session", keywords: "find past", run: () => go("history") },
  ];
  for (const ses of ctx.sessions.filter((x) => x.id !== ctx.activeSessionId).slice(0, 8)) {
    out.push({
      id: `session.open.${ses.id}`,
      title: `Open session: ${ses.title}`,
      section: "Session",
      keywords: `resume recent ${MODE_LABELS[ses.type]}`,
      run: () => api.switchSession(ses.id).then(() => go("assistant")),
    });
  }
  if (ctx.latestAnswer) {
    const text = ctx.latestAnswer;
    out.push({
      id: "answer.copy",
      title: "Copy latest answer",
      section: "Assistant",
      keywords: "clipboard response",
      run: () => api.copyText(text).then(() => ctx.notify("Copied the latest answer.")),
    });
  }
  out.push(
    { id: "assistant.open", title: "Go to assistant", section: "Navigate", run: () => go("assistant") },
    {
      id: "overlay.toggle",
      title: "Show or hide the floating panel",
      section: "Assistant",
      keywords: "overlay compact panel",
      shortcut: prettyAccelerator(s.shortcuts.toggleOverlay),
      run: () => api.overlay("toggle"),
    },
    { id: "overlay.compact", title: "Floating panel: compact", section: "Assistant", keywords: "overlay small", run: () => api.overlay("compact") },
    { id: "overlay.expand", title: "Floating panel: expanded", section: "Assistant", keywords: "overlay large", run: () => api.overlay("expand") },
    {
      id: "context.clear",
      title: "Clear this session's context",
      section: "Capture",
      keywords: "remove screen notes documents",
      run: () => api.clearContext().then(() => ctx.notify("Session context cleared.")),
    },
    { id: "capture.open", title: "Screen context…", section: "Capture", keywords: "capture screenshot", run: () => go("capture") },
  );
  if (s.consent.screen) {
    const ls = ctx.liveScreen;
    if (ls?.active && !ls.paused) out.push({ id: "live.pause", title: "Pause live screen context", section: "Capture", run: () => api.liveScreen("pause") });
    if (ls?.active && ls.paused) out.push({ id: "live.resume", title: "Resume live screen context", section: "Capture", run: () => api.liveScreen("resume") });
    if (ls?.active) out.push({ id: "live.stop", title: "Stop live screen context", section: "Capture", run: () => api.liveScreen("stop") });
  }
  const st = ctx.live.status;
  if (st === "recording") out.push({ id: "rec.pause", title: "Pause transcript", section: "Capture", keywords: "recording audio", run: () => api.transcriptPause() });
  if (st === "paused") out.push({ id: "rec.resume", title: "Resume transcript", section: "Capture", keywords: "recording audio", run: () => api.transcriptResume() });
  if (isRecordingStatus(st)) out.push({ id: "rec.stop", title: "Stop transcript", section: "Capture", keywords: "end recording", run: () => api.transcriptStop() });
  else if (s.consent.microphone) out.push({ id: "rec.open", title: "Start a live transcript…", section: "Capture", keywords: "record meeting notetaker", run: () => go("transcript") });

  // Provider switching only offers providers that are usable without further setup screens.
  const kinds: { kind: Settings["provider"]["kind"]; label: string }[] = [
    { kind: "anthropic", label: PROVIDER_INFO.anthropic.label },
    { kind: "openai", label: PROVIDER_INFO.openai.label },
    { kind: "gemini", label: PROVIDER_INFO.gemini.label },
    ...(s.inference.local.model ? [{ kind: "ollama" as const, label: `Local model (${s.inference.local.model})` }] : []),
  ];
  for (const k of kinds.filter((x) => x.kind !== s.provider.kind)) {
    out.push({
      id: `provider.${k.kind}`,
      title: `Use ${k.label}`,
      section: "Settings",
      keywords: "switch provider model ai",
      run: () => api.updateSettings({ provider: { kind: k.kind } }).then(() => ctx.notify(`Now using ${k.label}. Test it in AI provider settings.`)),
    });
  }
  out.push(
    { id: "go.provider", title: "AI provider settings", section: "Settings", keywords: "model key", run: () => go("provider") },
    { id: "go.settings", title: "Settings", section: "Settings", keywords: "preferences general", run: () => go("settings") },
    { id: "go.shortcuts", title: "Keyboard shortcuts", section: "Settings", keywords: "keys hotkeys", run: () => go("shortcuts") },
    { id: "go.privacy", title: "Privacy & data", section: "Settings", keywords: "delete retention export", run: () => go("privacy") },
    { id: "go.plan", title: "Plan & updates", section: "Help", keywords: "license upgrade version", run: () => go("plan") },
    { id: "go.help", title: "Help", section: "Help", keywords: "troubleshoot support faq", run: () => go("help") },
  );
  return out;
}

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const results = useMemo(() => rankCommands(commands, q), [commands, q]);
  // One guard per opening of the palette: blocks Enter+click / key-repeat double runs, without
  // swallowing a different command the user runs right after reopening.
  const guard = useRef(onceGuard());

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    guard.current = onceGuard();
    setQ("");
    setSel(0);
    setError(null);
    queueMicrotask(() => input.current?.focus());
    return () => restore.current?.focus?.();
  }, [open]);
  useEffect(() => setSel(0), [q]);
  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    void guard.current(async () => {
      try {
        await c.run();
        onClose();
      } catch (e) {
        setError(errMsg(e));
      }
    });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) run(results[sel]);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      e.preventDefault();
      input.current?.focus();
    }
  };
  const activeId = results[sel] ? `cmd-${results[sel]!.id}` : undefined;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <input
          ref={input}
          className="palette-input"
          placeholder="Type a command…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeId}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {error && (
          <div className="alert error small" role="alert" style={{ margin: "0 10px 8px" }}>
            {error}
          </div>
        )}
        <ul id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
          {results.length === 0 && (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              No matching command.
            </li>
          )}
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === sel}
              className="palette-item"
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c)}
            >
              <span className="palette-section">{c.section}</span>
              <span className="palette-title">{c.title}</span>
              {c.shortcut && <kbd className="palette-kbd">{c.shortcut}</kbd>}
            </li>
          ))}
        </ul>
        <div className="palette-foot small faint" aria-hidden>
          ↑↓ to move · Enter to run · Esc to close
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {results.length} command{results.length === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}
