/** A final or interim recognition result, timed relative to the start of the provider stream. */
export interface RecognitionResult {
  text: string;
  isFinal: boolean;
  startSec: number;
  endSec: number;
  speaker: string | null;
  /** Which input produced the audio when the stream is multichannel (0 = mic, 1 = system). */
  channel: number | null;
  confidence: number | null;
}

export interface TranscriptionStreamHandlers {
  onOpen: () => void;
  onResult: (r: RecognitionResult) => void;
  /** `unexpected` is true when the stream ended without close() being called. */
  onClose: (unexpected: boolean, reason: string, fatal: boolean) => void;
  onError: (message: string) => void;
}

export interface TranscriptionStream {
  /**
   * 16 kHz signed 16-bit little-endian PCM, interleaved when `channels` = 2. Returns false when
   * the transport is congested (or closed) and the chunk was NOT sent, so the caller can buffer.
   */
  sendAudio(pcm: Uint8Array): boolean;
  keepAlive(): void;
  close(): void;
}

export interface OpenOptions {
  language: string;
  diarize: boolean;
  /** 1 = microphone only; 2 = interleaved [mic, system]. */
  channels: 1 | 2;
}

/** Speech-recognition backend. Implementations must be replaceable without touching the UI. */
export interface TranscriptionProvider {
  readonly id: string;
  readonly sampleRate: number;
  open(opts: OpenOptions, handlers: TranscriptionStreamHandlers): TranscriptionStream;
}

/** Minimal WebSocket surface we depend on, so tests can inject a fake. */
export interface SocketLike {
  readyState: number;
  bufferedAmount?: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;
