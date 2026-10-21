import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CapturePreview } from "../../shared/api";
import type { CaptureCapabilities, CaptureRegion, CaptureSource, Settings } from "../../shared/types";
import { api } from "../lib/api";
import { useContextItems, useLiveScreen, useNow } from "../lib/hooks";
import { ContextChips, Empty, Switch, useAction } from "../components/ui";

export function CaptureScreen({ settings, update, go }: { settings: Settings; update: (p: unknown) => Promise<void>; go: (r: string) => void }) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [captured, setCaptured] = useState<CapturePreview | null>(null);
  const { run, error, busy } = useAction();
  const items = useContextItems().filter((i) => i.source === "screenshot" || i.source === "ocr");
  const live = useLiveScreen();
  const now = useNow(1000);

  const load = () =>
    run(async () => {
      setCaps(await api.captureCapabilities());
      setSources(await api.listCaptureSources());
    });
  useEffect(() => {
    void api.captureCapabilities().then(setCaps);
    if (settings.consent.screen) void load();
  }, [settings.consent.screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <header className="page-header">
      <h1>Screen context</h1>
      <span className="muted small">Capture a screen, window or region — or import an image — and Lumen reads its text on-device before you ask.</span>
      <span className="spacer" />
      {settings.consent.screen && (
        <>
          <button className="btn" onClick={() => void run(async () => setCaptured(await api.importImage()))}>
            ⇪ Import image
          </button>
          <button className="btn" onClick={() => void load()} disabled={busy}>
            {busy ? <span className="spinner" /> : "↻"} Refresh
          </button>
        </>
      )}
    </header>
  );

  if (!settings.consent.screen) {
    return (
      <>
        {header}
        <Empty title="Screen context is off" action={<button className="btn primary" onClick={() => go("permissions")}>Open permissions</button>}>
          Lumen never captures your screen in the background. Enable screen context to capture a screen, a window or a region when you ask.
        </Empty>
      </>
    );
  }

  const pick = (s: CaptureSource) => run(async () => setCaptured(await api.captureSource(s.id)));

  return (
    <>
      {header}
      <div className="page">
        {error && (
          <div className="alert error" role="alert" style={{ marginBottom: 12 }}>
            {error}
            {/Screen Recording|blocking/i.test(error) && (
              <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void api.openPermissionSettings("screen")}>
                Open System Settings
              </button>
            )}
          </div>
        )}

        <div className="card">
          <div className="row">
            <div className="grow">
              <h3 style={{ margin: 0 }}>Processing</h3>
              <div className="small muted">Applies to every capture.</div>
            </div>
          </div>
          <div className="field">
            <div>
              <div className="label">Read text on-device (OCR)</div>
              <div className="hint">Tesseract runs locally; recognized text is shown before use and sent as context.</div>
            </div>
            <Switch label="OCR" checked={settings.screen.ocr} onChange={(v) => void update({ screen: { ocr: v } })} />
          </div>
          <div className="field">
            <div>
              <div className="label">Send the image to the AI</div>
              <div className="hint">Lets vision models see layout, charts and diagrams. Turn off to send recognized text only.</div>
            </div>
            <Switch label="Send images" checked={settings.screen.sendImages} onChange={(v) => void update({ screen: { sendImages: v } })} />
          </div>
          <div className="field">
            <div>
              <div className="label">Preview before use</div>
              <div className="hint">Shortcut captures wait for you to confirm them in the panel before any question can use them.</div>
            </div>
            <Switch label="Preview before use" checked={settings.screen.requirePreview} onChange={(v) => void update({ screen: { requirePreview: v } })} />
          </div>
        </div>

        {caps?.liveScreen && (
          <div className="card">
            <div className="row">
              <div className="grow">
                <h3 style={{ margin: 0 }}>Live screen context</h3>
                <div className="small muted">
                  Off by default. While on, Lumen samples the display under your cursor every {settings.screen.liveIntervalSec}s and keeps only the latest frame. A “Live screen” indicator stays visible in the panel and menu bar.
                </div>
              </div>
              {live?.active ? (
                <>
                  {live.paused ? (
                    <button className="btn" onClick={() => void run(() => api.liveScreen("resume"))}>
                      ▶ Resume
                    </button>
                  ) : (
                    <button className="btn" onClick={() => void run(() => api.liveScreen("pause"))}>
                      ❚❚ Pause
                    </button>
                  )}
                  <button className="btn danger solid" onClick={() => void run(() => api.liveScreen("stop"))}>
                    ■ Stop
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => void run(() => api.liveScreen("start"))}>
                  Start live context
                </button>
              )}
            </div>
            {live?.active && (
              <div className="small faint" style={{ marginTop: 6 }}>
                {live.captures} frames · {live.lastCaptureAt ? `last ${Math.max(0, Math.round((now - live.lastCaptureAt) / 1000))}s ago` : "starting…"}
                {live.lastError && <span style={{ color: "var(--danger)" }}> · {live.lastError}</span>}
              </div>
            )}
          </div>
        )}

        {items.length > 0 && (
          <div style={{ margin: "16px 0" }}>
            <div className="section-label">
              In this session (screen captures expire after {settings.privacy.screenContextTtlMinutes} min unless pinned)
              <button className="btn ghost sm" onClick={() => void api.clearContext("screen")}>
                Clear screen context
              </button>
            </div>
            <ContextChips items={items} />
          </div>
        )}

        {captured ? (
          <RegionPicker
            captured={captured}
            onCancel={() => {
              void api.discardCapture(captured.captureId);
              setCaptured(null);
            }}
            onAttach={(region) =>
              run(async () => {
                await api.attachCapture(captured.captureId, region, region ? `Region of ${captured.title}` : captured.title);
                setCaptured(null);
                void api.overlay("toggle");
              })
            }
          />
        ) : sources === null ? (
          <div className="row muted">{busy ? <><span className="spinner" /> Looking for screens and windows…</> : "No capture sources loaded."}</div>
        ) : sources.length === 0 ? (
          <Empty title="Nothing to capture">
            {api.platform === "darwin"
              ? "macOS returned no capturable sources. Grant Screen Recording permission to Lumen in System Settings → Privacy & Security, then restart Lumen. You can still import an image."
              : "No screens or windows are available for capture. You can still import an image."}
          </Empty>
        ) : (
          <>
            <div className="section-label">Screens</div>
            <div className="capture-grid">
              {sources.filter((s) => s.kind === "screen").map((s) => (
                <Tile key={s.id} s={s} onPick={pick} />
              ))}
            </div>
            {caps?.windows !== false && (
              <>
                <div className="section-label">Windows</div>
                <div className="capture-grid">
                  {sources.filter((s) => s.kind === "window").map((s) => (
                    <Tile key={s.id} s={s} onPick={pick} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {caps && (
          <details className="card" style={{ marginTop: 16 }}>
            <summary className="small">Platform support ({caps.platform})</summary>
            <ul className="small muted">
              <li>Screens: {caps.screens ? "yes" : "no"} · Windows: {caps.windows ? "yes" : "no"} · Regions: {caps.region ? "yes" : "no"} · Image import: yes · OCR: on-device</li>
              <li>OS permission: {caps.permission}</li>
              {caps.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </>
  );
}

function Tile({ s, onPick }: { s: CaptureSource; onPick: (s: CaptureSource) => void }) {
  return (
    <button className="capture-tile" onClick={() => onPick(s)}>
      {s.thumbnailDataUrl ? <img src={s.thumbnailDataUrl} alt="" /> : <div className="muted small" style={{ height: 110, display: "grid", placeItems: "center" }}>No preview</div>}
      <div title={s.name}>{s.name}</div>
    </button>
  );
}

function RegionPicker({ captured, onCancel, onAttach }: { captured: CapturePreview; onCancel: () => void; onAttach: (r: CaptureRegion | null) => Promise<unknown> }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const down = useRef(false);

  const pos = (e: PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  const box = drag && { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) };
  const hasRegion = !!box && box.width >= 6 && box.height >= 6;
  const toRegion = (): CaptureRegion | null => {
    if (!box || !hasRegion || !imgRef.current) return null;
    const scale = captured.width / imgRef.current.getBoundingClientRect().width;
    return { x: box.left * scale, y: box.top * scale, width: box.width * scale, height: box.height * scale };
  };
  const attach = async (region: CaptureRegion | null) => {
    setBusy(true);
    await onAttach(region);
    setBusy(false);
  };

  return (
    <div className="col">
      <div className="row">
        <strong>{captured.title}</strong>
        <span className="muted small">
          {captured.width}×{captured.height} · drag to select a region
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onCancel}>
          Discard
        </button>
        <button className="btn" disabled={busy} onClick={() => void attach(null)}>
          Use whole capture
        </button>
        <button className="btn primary" disabled={busy || !hasRegion} onClick={() => void attach(toRegion())}>
          Use region
        </button>
      </div>
      <div
        className="region-stage"
        onPointerDown={(e) => {
          down.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const p = pos(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => {
          if (!down.current) return;
          const p = pos(e);
          setDrag((d) => d && { ...d, x1: p.x, y1: p.y });
        }}
        onPointerUp={() => {
          down.current = false;
        }}
      >
        <img ref={imgRef} src={captured.previewDataUrl} alt={`Capture of ${captured.title}`} draggable={false} />
        {box && box.width > 2 && <div className="region-box" style={box} />}
      </div>
      <div className="small faint">This preview is what will be used. The capture stays in memory only, is read on-device, and is never written to disk.</div>
    </div>
  );
}
