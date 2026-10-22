import type {
  OpenOptions,
  RecognitionResult,
  SocketFactory,
  SocketLike,
  TranscriptionProvider,
  TranscriptionStream,
  TranscriptionStreamHandlers,
} from "./types";

const OPEN = 1;
/** Stop handing audio to the socket once this much is queued but unsent (≈ 4 s of mono audio). */
export const MAX_SOCKET_BUFFER_BYTES = 128_000;

export const defaultSocketFactory: SocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike;

/**
 * Deepgram live streaming speech-to-text (wss://api.deepgram.com/v1/listen).
 * Auth uses the documented `token` WebSocket subprotocol so the key never appears in a URL.
 * With two channels, mic and system audio are recognized independently (`multichannel=true`).
 */
export class DeepgramProvider implements TranscriptionProvider {
  readonly id = "deepgram";
  readonly sampleRate = 16_000;

  constructor(
    private readonly apiKey: string,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly model = "nova-3",
    private readonly baseUrl = "wss://api.deepgram.com/v1/listen",
  ) {}

  buildUrl(opts: OpenOptions): string {
    const p = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: String(opts.channels),
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "300",
      language: opts.language,
      diarize: String(opts.diarize),
    });
    if (opts.channels === 2) p.set("multichannel", "true");
    return `${this.baseUrl}?${p}`;
  }

  open(opts: OpenOptions, h: TranscriptionStreamHandlers): TranscriptionStream {
    const ws = this.socketFactory(this.buildUrl(opts), ["token", this.apiKey]);
    ws.binaryType = "arraybuffer";
    let closedByUs = false;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      h.onOpen();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const r = parseDeepgramMessage(ev.data);
      if (r) h.onResult(r);
    };
    ws.onerror = () => h.onError("Transcription connection error.");
    ws.onclose = (ev) => {
      // A handshake rejection (bad key) closes before open; 1008/4001/4008 are policy/auth closes.
      const auth = ev.code === 1008 || ev.code === 4001 || ev.code === 4008 || /auth|credential|401|403/i.test(ev.reason);
      const fatal = auth || (!opened && ev.code === 1002);
      const reason = auth ? "Deepgram rejected the API key." : ev.reason || `connection closed (code ${ev.code})`;
      h.onClose(!closedByUs, reason, fatal);
    };
    return {
      sendAudio(pcm) {
        if (ws.readyState !== OPEN) return false;
        if ((ws.bufferedAmount ?? 0) > MAX_SOCKET_BUFFER_BYTES) return false;
        ws.send(pcm);
        return true;
      },
      keepAlive() {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      },
      close() {
        closedByUs = true;
        try {
          if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000, "client closed");
        } catch {
          /* already closed */
        }
      },
    };
  }
}

interface DgWord {
  speaker?: number;
}
interface DgResults {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel_index?: number[];
  channel?: { alternatives?: { transcript?: string; confidence?: number; words?: DgWord[] }[] };
}

export function parseDeepgramMessage(raw: string): RecognitionResult | null {
  let msg: DgResults;
  try {
    msg = JSON.parse(raw) as DgResults;
  } catch {
    return null;
  }
  if (msg.type !== "Results") return null;
  const alt = msg.channel?.alternatives?.[0];
  const text = alt?.transcript?.trim() ?? "";
  if (!text) return null;
  // Majority speaker across words; only reported when diarization produced labels.
  const counts = new Map<number, number>();
  for (const w of alt?.words ?? []) if (typeof w.speaker === "number") counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  let speaker: string | null = null;
  if (counts.size) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    speaker = `Speaker ${top[0] + 1}`;
  }
  const start = msg.start ?? 0;
  return {
    text,
    isFinal: !!msg.is_final,
    startSec: start,
    endSec: start + (msg.duration ?? 0),
    speaker,
    channel: Array.isArray(msg.channel_index) && typeof msg.channel_index[0] === "number" ? msg.channel_index[0] : null,
    confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
  };
}
