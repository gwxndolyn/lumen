import { randomUUID } from "node:crypto";
import type { TranscriptEvent, TranscriptSegment, TranscriptStatus } from "../../shared/types";
import type { Store } from "../storage/db";
import type { RecognitionResult, TranscriptionProvider, TranscriptionStream } from "./types";

export interface SessionOptions {
  /** Workspace session the transcript belongs to. */
  workspaceSessionId: string;
  language: string;
  diarize: boolean;
  title: string;
  /** 1 = mic only; 2 = interleaved [mic, system audio]. */
  channels?: 1 | 2;
  vocabulary?: string[];
  /** When false, segments live in memory only and are discarded on stop. */
  persist?: boolean;
  /** Max bytes of audio buffered while reconnecting (~30 s at 16 kHz mono 16-bit). */
  maxBufferBytes?: number;
  maxReconnects?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

const CHANNEL_NAMES: Record<number, TranscriptSegment["channel"]> = { 0: "mic", 1: "system" };

/**
 * Owns one live transcription: provider stream lifecycle, pause/resume, reconnect with audio
 * buffering after transient network loss, duplicate suppression, and persistence of final
 * segments only. Interim results are shown but never stored, so the transcript only contains what
 * the recognizer finalized.
 */
export class TranscriptSession {
  readonly id: string;
  readonly workspaceSessionId: string;
  readonly persisted: boolean;
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
  private pausedAt: number | null = null;
  private segments: TranscriptSegment[] = [];
  private dropped = 0;
  private readonly opts: Required<Omit<SessionOptions, "title" | "workspaceSessionId">> & { title: string };

  constructor(
    private readonly provider: TranscriptionProvider,
    private readonly store: Store,
    private readonly emit: (e: TranscriptEvent) => void,
    opts: SessionOptions,
    private readonly onLatency?: (ms: number) => void,
  ) {
    this.opts = {
      channels: 1,
      persist: true,
      vocabulary: [],
      maxBufferBytes: 16_000 * 2 * 30,
      maxReconnects: 6,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: Date.now,
      ...opts,
    };
    this.workspaceSessionId = opts.workspaceSessionId;
    this.persisted = this.opts.persist;
    this.startedAt = this.opts.now();
    this.id = this.persisted ? store.createTranscriptSession(opts.workspaceSessionId, opts.title, provider.id, this.startedAt).id : `mem-${randomUUID()}`;
    this.connect();
  }

  get title() {
    return this.opts.title;
  }

  get started() {
    return this.startedAt;
  }

  get channels() {
    return this.opts.channels;
  }

  private setStatus(status: TranscriptStatus, detail?: string, action?: "retry" | "settings" | "microphone" | "permissions") {
    this.status = status;
    this.emit({ type: "status", sessionId: this.id, workspaceSessionId: this.workspaceSessionId, status, detail, action });
  }

  private connect() {
    this.setStatus(this.reconnects ? "reconnecting" : "connecting", this.reconnects ? "Reconnecting to the transcription service…" : undefined);
    this.streamOffsetMs = this.opts.now() - this.startedAt - this.bufferedMs();
    this.stream = this.provider.open(
      { language: this.opts.language, diarize: this.opts.diarize, channels: this.opts.channels, vocabulary: this.opts.vocabulary },
      {
        onOpen: () => {
          this.reconnects = 0;
          this.flush();
          this.startKeepAlive();
          if (this.status !== "paused") this.setStatus("recording");
        },
        onResult: (r) => this.onResult(r),
        onError: (message) => this.emit({ type: "status", sessionId: this.id, workspaceSessionId: this.workspaceSessionId, status: this.status, detail: message }),
        onClose: (unexpected, reason, fatal) => {
          this.stopKeepAlive();
          this.stream = null;
          if (!unexpected || this.status === "stopped" || this.status === "error") return;
          if (fatal) {
            this.finish("error", reason, /API key/.test(reason) ? "settings" : "retry");
            return;
          }
          if (this.reconnects >= this.opts.maxReconnects) {
            this.finish("error", `Transcription disconnected and could not reconnect: ${reason}`, "retry");
            return;
          }
          this.reconnects++;
          const delay = Math.min(500 * 2 ** (this.reconnects - 1), 8000);
          const wasPaused = this.status === "paused";
          if (!wasPaused) this.setStatus("reconnecting", `Connection lost — retrying in ${Math.round(delay / 100) / 10}s (audio is buffered)`);
          this.reconnectTimer = this.opts.setTimer(() => {
            this.reconnectTimer = null;
            if (this.status !== "stopped" && this.status !== "error") this.connect();
          }, delay);
        },
      },
    );
  }

  private onResult(r: RecognitionResult) {
    const channel = r.channel === null ? (this.opts.channels === 1 ? "mic" : null) : (CHANNEL_NAMES[r.channel] ?? null);
    if (!r.isFinal) {
      this.emit({ type: "interim", sessionId: this.id, text: r.text, speaker: this.label(r.speaker, channel), channel });
      return;
    }
    const startMs = Math.round(this.streamOffsetMs + r.startSec * 1000);
    const endMs = Math.round(this.streamOffsetMs + r.endSec * 1000);
    if (this.isDuplicate(r.text, startMs, endMs, channel)) return;
    const base = { sessionId: this.id, startMs, endMs, speaker: this.label(r.speaker, channel), channel, text: r.text, confidence: r.confidence };
    const seg: TranscriptSegment = this.persisted ? this.store.addSegment(base) : { ...base, id: randomUUID(), edited: false };
    // Keep chronological order even when channels finalize out of order.
    let i = this.segments.length;
    while (i > 0 && this.segments[i - 1]!.startMs > seg.startMs) i--;
    this.segments.splice(i, 0, seg);
    if (this.segments.length > 2000) this.segments.shift();
    const latency = this.lastAudioAt ? Math.max(0, this.opts.now() - this.lastAudioAt) : null;
    if (latency !== null) this.onLatency?.(latency);
    this.emit({ type: "segment", segment: seg, latencyMs: latency });
  }

  /** Labels speakers per channel so "Speaker 1" on the mic is not confused with "Speaker 1" on system audio. */
  private label(speaker: string | null, channel: TranscriptSegment["channel"]): string | null {
    if (this.opts.channels === 1) return speaker;
    if (channel === "mic") return speaker ? `You (${speaker})` : "You";
    if (channel === "system") return speaker ? `Remote ${speaker}` : "Remote";
    return speaker;
  }

  /**
   * Recognizers can re-emit a final after a reconnect replays buffered audio. Treat a final as a
   * duplicate if the same channel already has identical text overlapping the same time window.
   */
  private isDuplicate(text: string, startMs: number, endMs: number, channel: TranscriptSegment["channel"]): boolean {
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    for (let i = this.segments.length - 1; i >= 0 && i >= this.segments.length - 20; i--) {
      const s = this.segments[i]!;
      if (s.channel !== channel) continue;
      const overlaps = startMs <= s.endMs + 1500 && endMs >= s.startMs - 1500;
      if (overlaps && s.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === norm) return true;
    }
    return false;
  }

  private bufferedMs() {
    return (this.bufferedBytes / (this.provider.sampleRate * 2 * this.opts.channels)) * 1000;
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
      // Keep order: drain the backlog first; if the transport is congested, buffer instead.
      if (this.buffer.length) this.flush();
      if (!this.buffer.length && this.stream.sendAudio(pcm)) return;
    }
    // Not connected, reconnecting or congested: buffer, dropping the oldest audio past the cap.
    this.buffer.push(pcm);
    this.bufferedBytes += pcm.byteLength;
    while (this.bufferedBytes > this.opts.maxBufferBytes && this.buffer.length) {
      this.bufferedBytes -= this.buffer.shift()!.byteLength;
      this.dropped++;
    }
  }

  /** Send buffered audio in order until the transport pushes back. */
  private flush() {
    while (this.buffer.length && this.stream) {
      const chunk = this.buffer[0]!;
      if (!this.stream.sendAudio(chunk)) break;
      this.buffer.shift();
      this.bufferedBytes -= chunk.byteLength;
    }
  }

  /** Audio chunks discarded because the buffer cap was reached (exposed for diagnostics). */
  get droppedChunks() {
    return this.dropped;
  }

  get bufferedAudioBytes() {
    return this.bufferedBytes;
  }

  pause() {
    if (this.status === "recording" || this.status === "reconnecting" || this.status === "connecting") {
      this.pausedAt = this.opts.now();
      this.setStatus("paused", "Audio is not being sent while paused.");
    }
  }

  resume() {
    if (this.status !== "paused") return;
    // Recognizer timestamps only advance with audio, so shift the offset by the paused duration.
    if (this.pausedAt !== null) this.streamOffsetMs += this.opts.now() - this.pausedAt;
    this.pausedAt = null;
    if (this.stream) this.setStatus("recording");
    else this.connect();
  }

  stop() {
    this.finish("stopped");
  }

  private finish(status: "stopped" | "error", detail?: string, action?: "retry" | "settings") {
    if (this.status === "stopped" || this.status === "error") return;
    this.stopKeepAlive();
    if (this.reconnectTimer) this.opts.clearTimer(this.reconnectTimer);
    this.status = status;
    this.stream?.close();
    this.stream = null;
    this.buffer = [];
    this.bufferedBytes = 0;
    if (this.persisted) this.store.endTranscriptSession(this.id, this.opts.now());
    else this.segments = []; // memory-only transcripts are discarded when recording ends
    this.emit({ type: "status", sessionId: this.id, workspaceSessionId: this.workspaceSessionId, status, detail, action });
  }

  liveSegments(): TranscriptSegment[] {
    return [...this.segments];
  }

  /** Recent finalized transcript text for live context (bounded). */
  recentTranscript(maxChars = 12_000): string {
    const lines: string[] = [];
    let n = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const t = this.segments[i]!;
      const line = `[${formatTs(t.startMs)}] ${t.speaker ? `${t.speaker}: ` : ""}${t.text}`;
      n += line.length + 1;
      if (n > maxChars) break;
      lines.unshift(line);
    }
    return lines.join("\n");
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
