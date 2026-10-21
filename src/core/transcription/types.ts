/** A final or interim recognition result, timed relative to the start of the provider stream. */
export interface RecognitionResult {
  text: string;
  isFinal: boolean;
  startSec: number;
  endSec: number;
  speaker: string | null;
}

export interface TranscriptionStreamHandlers {
  onOpen: () => void;
  onResult: (r: RecognitionResult) => void;
  /** `unexpected` is true when the stream ended without close() being called. */
  onClose: (unexpected: boolean, reason: string) => void;
  onError: (message: string) => void;
}

export interface TranscriptionStream {
  /** 16 kHz mono signed 16-bit little-endian PCM. */
  sendAudio(pcm: Uint8Array): void;
  keepAlive(): void;
  close(): void;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly sampleRate: number;
  open(opts: { language: string; diarize: boolean }, handlers: TranscriptionStreamHandlers): TranscriptionStream;
}

/** Minimal WebSocket surface we depend on, so tests can inject a fake. */
export interface SocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;
