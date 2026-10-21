import type {
  RecognitionResult,
  SocketFactory,
  SocketLike,
  TranscriptionProvider,
  TranscriptionStream,
  TranscriptionStreamHandlers,
} from "./types";

const OPEN = 1;

export const defaultSocketFactory: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as SocketLike;

/**
 * Deepgram live streaming speech-to-text (wss://api.deepgram.com/v1/listen).
 * Auth uses the documented `token` WebSocket subprotocol so the key never appears in a URL.
 */
export class DeepgramProvider implements TranscriptionProvider {
  readonly id = "deepgram";
  readonly sampleRate = 16_000;

  constructor(
    private readonly apiKey: string,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
    private readonly model = "nova-3",
  ) {}

  buildUrl(language: string, diarize: boolean): string {
    const p = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "300",
      language,
      diarize: String(diarize),
    });
    return `wss://api.deepgram.com/v1/listen?${p}`;
  }

  open(opts: { language: string; diarize: boolean }, h: TranscriptionStreamHandlers): TranscriptionStream {
    const ws = this.socketFactory(this.buildUrl(opts.language, opts.diarize), ["token", this.apiKey]);
    ws.binaryType = "arraybuffer";
    let closedByUs = false;
    ws.onopen = () => h.onOpen();
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const r = parseDeepgramMessage(ev.data);
      if (r) h.onResult(r);
    };
    ws.onerror = () => h.onError("Transcription connection error.");
    ws.onclose = (ev) => {
      const reason =
        ev.code === 1008 || ev.code === 4001 || /auth|credential|401/i.test(ev.reason)
          ? "Deepgram rejected the API key."
          : ev.reason || `closed (${ev.code})`;
      h.onClose(!closedByUs, reason);
    };
    return {
      sendAudio(pcm) {
        if (ws.readyState === OPEN) ws.send(pcm);
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
  channel?: { alternatives?: { transcript?: string; words?: DgWord[] }[] };
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
  return { text, isFinal: !!msg.is_final, startSec: start, endSec: start + (msg.duration ?? 0), speaker };
}
