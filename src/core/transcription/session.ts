import type { TranscriptEvent, TranscriptSegment, TranscriptStatus } from "../../shared/types";
import type { Store } from "../storage/db";
import type { TranscriptionProvider, TranscriptionStream } from "./types";

export interface SessionOptions {
  language: string;
  diarize: boolean;
  title: string;
  /** Max bytes of audio buffered while reconnecting (~30 s at 16 kHz mono 16-bit). */
  maxBufferBytes?: number;
  maxReconnects?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

/**
 * Owns one live transcription session: provider stream lifecycle, pause/resume, reconnect with
 * audio buffering after transient network loss, and persistence of final segments only.
 * Interim results are shown but never stored, so the transcript only contains what the
 * recognizer finalized.
 */
export class TranscriptSession {
  readonly id: string;
  status: TranscriptStatus = "connecting";
  private stream: TranscriptionStream | null = null;
  private buffer: Uint8Array[] = [];
  private bufferedBytes = 0;
  private reconnects = 0;
  /** ms offset of the current provider stream relative to session start. */
  private streamOffsetMs = 0;
  private keepAliveTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private readonly startedAt: number;
  private lastAudioAt = 0;
  private recentText: { at: number; speaker: string | null; text: string }[] = [];
  private readonly opts: Required<Omit<SessionOptions, "title">> & { title: string };

  constructor(
    private readonly provider: TranscriptionProvider,
    private readonly store: Store,
    private readonly emit: (e: TranscriptEvent) => void,
    opts: SessionOptions,
    private readonly onLatency?: (ms: number) => void,
  ) {
    this.opts = {
      maxBufferBytes: 16_000 * 2 * 30,
      maxReconnects: 6,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: Date.now,
      ...opts,
    };
    this.startedAt = this.opts.now();
    this.id = store.createTranscriptSession(opts.title, provider.id, this.startedAt).id;
    this.connect();
  }

  get title() {
    return this.opts.title;
  }

  private setStatus(status: TranscriptStatus, detail?: string) {
    this.status = status;
    this.emit({ type: "status", sessionId: this.id, status, detail });
  }

  private connect() {
    this.setStatus(this.reconnects ? "reconnecting" : "connecting");
    this.streamOffsetMs = this.opts.now() - this.startedAt - this.bufferedMs();
    this.stream = this.provider.open(
      { language: this.opts.language, diarize: this.opts.diarize },
      {
        onOpen: () => {
          this.reconnects = 0;
          for (const chunk of this.buffer) this.stream?.sendAudio(chunk);
          this.buffer = [];
          this.bufferedBytes = 0;
          this.setStatus(this.status === "paused" ? "paused" : "recording");
          this.startKeepAlive();
        },
        onResult: (r) => {
          if (r.isFinal) {
            const seg = this.store.addSegment({
              sessionId: this.id,
              startMs: Math.round(this.streamOffsetMs + r.startSec * 1000),
              endMs: Math.round(this.streamOffsetMs + r.endSec * 1000),
              speaker: r.speaker,
              text: r.text,
            });
            this.recentText.push({ at: seg.startMs, speaker: seg.speaker, text: seg.text });
            if (this.recentText.length > 400) this.recentText.shift();
            const latency = this.lastAudioAt ? Math.max(0, this.opts.now() - this.lastAudioAt) : null;
            if (latency !== null) this.onLatency?.(latency);
            this.emit({ type: "segment", segment: seg, latencyMs: latency });
          } else {
            this.emit({ type: "interim", sessionId: this.id, text: r.text, speaker: r.speaker });
          }
        },
        onError: (message) => this.emit({ type: "status", sessionId: this.id, status: this.status, detail: message }),
        onClose: (unexpected, reason) => {
          this.stopKeepAlive();
          this.stream = null;
          if (!unexpected || this.status === "stopped") return;
          if (/rejected the API key/.test(reason) || this.reconnects >= this.opts.maxReconnects) {
            this.finish("error", /rejected/.test(reason) ? reason : `Transcription disconnected: ${reason}`);
            return;
          }
          this.reconnects++;
          const delay = Math.min(500 * 2 ** (this.reconnects - 1), 8000);
          this.setStatus("reconnecting", `Connection lost — retrying in ${Math.round(delay / 100) / 10}s (audio is buffered)`);
          this.reconnectTimer = this.opts.setTimer(() => {
            this.reconnectTimer = null;
            if (this.status !== "stopped" && this.status !== "error") this.connect();
          }, delay);
        },
      },
    );
  }

  private bufferedMs() {
    return (this.bufferedBytes / (this.provider.sampleRate * 2)) * 1000;
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    const tick = () => {
      this.stream?.keepAlive();
      this.keepAliveTimer = this.opts.setTimer(tick, 8000);
    };
    this.keepAliveTimer = this.opts.setTimer(tick, 8000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) this.opts.clearTimer(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  pushAudio(pcm: Uint8Array) {
    if (this.status === "paused" || this.status === "stopped" || this.status === "error") return;
    this.lastAudioAt = this.opts.now();
    if (this.stream && this.status === "recording") {
      this.stream.sendAudio(pcm);
      return;
    }
    // Not connected yet / reconnecting: buffer, dropping the oldest audio past the cap.
    this.buffer.push(pcm);
    this.bufferedBytes += pcm.byteLength;
    while (this.bufferedBytes > this.opts.maxBufferBytes && this.buffer.length) {
      this.bufferedBytes -= this.buffer.shift()!.byteLength;
    }
  }

  pause() {
    if (this.status === "recording" || this.status === "reconnecting" || this.status === "connecting") this.setStatus("paused");
  }

  resume() {
    if (this.status !== "paused") return;
    if (this.stream) this.setStatus("recording");
    else this.connect();
  }

  stop() {
    this.finish("stopped");
  }

  private finish(status: "stopped" | "error", detail?: string) {
    if (this.status === "stopped") return;
    this.stopKeepAlive();
    if (this.reconnectTimer) this.opts.clearTimer(this.reconnectTimer);
    this.status = status;
    this.stream?.close();
    this.stream = null;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.store.endTranscriptSession(this.id, this.opts.now());
    this.emit({ type: "status", sessionId: this.id, status, detail });
  }

  /** Recent finalized transcript text for live context (bounded). */
  recentTranscript(maxChars = 12_000): string {
    const lines: string[] = [];
    let n = 0;
    for (let i = this.recentText.length - 1; i >= 0; i--) {
      const t = this.recentText[i]!;
      const line = `[${formatTs(t.at)}] ${t.speaker ? `${t.speaker}: ` : ""}${t.text}`;
      n += line.length + 1;
      if (n > maxChars) break;
      lines.unshift(line);
    }
    return lines.join("\n");
  }

  get started() {
    return this.startedAt;
  }
}

export function formatTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function segmentsToText(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${formatTs(s.startMs)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
}
