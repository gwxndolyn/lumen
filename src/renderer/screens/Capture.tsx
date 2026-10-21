import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CaptureRegion, CaptureSource, Settings } from "../../shared/types";
import { api, errMsg } from "../lib/api";
import { useContextItems } from "../lib/hooks";
import { ContextChips, Empty } from "../components/ui";

interface Captured {
  captureId: string;
  previewDataUrl: string;
  width: number;
  height: number;
  name: string;
}

export function CaptureScreen({ settings, go }: { settings: Settings; go: (r: string) => void }) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const items = useContextItems().filter((i) => i.kind === "screenshot");

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setSources(await api.listCaptureSources());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (settings.consent.screen) void load();
  }, [settings.consent.screen]);

  if (!settings.consent.screen) {
    return (
      <>
        <header className="page-header">
          <h1>Screen capture</h1>
        </header>
        <Empty title="Screen context is off" action={<button className="btn primary" onClick={() => go("permissions")}>Open permissions</button>}>
          Lumen never captures your screen in the background. Enable screen context to capture a screen, a window or a region when you ask.
        </Empty>
      </>
    );
  }

  const pick = async (s: CaptureSource) => {
    setError(null);
    try {
      const c = await api.captureSource(s.id);
      setCaptured({ ...c, name: s.name });
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <>
      <header className="page-header">
        <h1>Screen capture</h1>
        <span className="muted small">Pick a screen or window, optionally drag to select a region, then attach it to your next question.</span>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : "↻"} Refresh
        </button>
      </header>
      <div className="page">
        {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}</div>}
        {items.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="section-label">Attached screenshots (cleared after 15 minutes unless pinned)</div>
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
            onAttach={async (region) => {
              try {
                await api.attachCapture(captured.captureId, region, region ? `Region of ${captured.name}` : captured.name);
                setCaptured(null);
                void api.overlay("toggle");
              } catch (err) {
                setError(errMsg(err));
              }
            }}
          />
        ) : sources === null ? (
          <div className="row muted">
            <span className="spinner" /> Looking for screens and windows…
          </div>
        ) : sources.length === 0 ? (
          <Empty title="Nothing to capture">
            {api.platform === "darwin"
              ? "macOS returned no capturable sources. Grant Screen Recording permission to Lumen in System Settings → Privacy & Security, then restart Lumen."
              : "No screens or windows are available for capture."}
          </Empty>
        ) : (
          <>
            <div className="section-label">Screens</div>
            <div className="capture-grid">
              {sources.filter((s) => s.kind === "screen").map((s) => (
                <Tile key={s.id} s={s} onPick={pick} />
              ))}
            </div>
            <div className="section-label">Windows</div>
            <div className="capture-grid">
              {sources.filter((s) => s.kind === "window").map((s) => (
                <Tile key={s.id} s={s} onPick={pick} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Tile({ s, onPick }: { s: CaptureSource; onPick: (s: CaptureSource) => void }) {
  return (
    <button className="capture-tile" onClick={() => onPick(s)}>
      <img src={s.thumbnailDataUrl} alt="" />
      <div title={s.name}>{s.name}</div>
    </button>
  );
}

function RegionPicker({ captured, onCancel, onAttach }: { captured: Captured; onCancel: () => void; onAttach: (r: CaptureRegion | null) => Promise<void> }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const down = useRef(false);

  const pos = (e: PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  const box = drag && {
    left: Math.min(drag.x0, drag.x1),
    top: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0),
    height: Math.abs(drag.y1 - drag.y0),
  };
  const toRegion = (): CaptureRegion | null => {
    if (!box || box.width < 6 || box.height < 6 || !imgRef.current) return null;
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
        <strong>{captured.name}</strong>
        <span className="muted small">
          {captured.width}×{captured.height} · drag to select a region
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onCancel}>
          Discard
        </button>
        <button className="btn" disabled={busy} onClick={() => void attach(null)}>
          Attach whole capture
        </button>
        <button className="btn primary" disabled={busy || !toRegion()} onClick={() => void attach(toRegion())}>
          Attach region
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
        <img ref={imgRef} src={captured.previewDataUrl} alt={`Capture of ${captured.name}`} draggable={false} />
        {box && box.width > 2 && <div className="region-box" style={box} />}
      </div>
      <div className="small faint">The capture stays in memory only. It is sent to the AI provider only when you ask a question with it attached, and is never written to disk.</div>
    </div>
  );
}
