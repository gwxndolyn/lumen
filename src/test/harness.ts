import Anthropic from "@anthropic-ai/sdk";
import type { AppEvent } from "../shared/api";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { applySettingsPatch } from "../shared/settingsSchema";
import type { ChatEvent, SecretName, Settings, TranscriptEvent } from "../shared/types";
import { AppCore } from "../core/app";
import type { OcrEngine } from "../core/ocr";
import { AnthropicProvider } from "../core/providers/anthropic";
import { MockProvider } from "../core/providers/mock";
import { Store } from "../core/storage/db";
import { DeepgramProvider } from "../core/transcription/deepgram";
import type { SocketLike } from "../core/transcription/types";
import { fakeFetch, noSleep, type FakeTurn } from "./helpers";

export class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  result(text: string, isFinal: boolean, start = 0, speaker?: number, channel?: number) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "Results",
        is_final: isFinal,
        start,
        duration: 1,
        ...(channel !== undefined ? { channel_index: [channel, 2] } : {}),
        channel: { alternatives: [{ transcript: text, confidence: 0.93, words: speaker === undefined ? [] : [{ speaker }] }] },
      }),
    });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

export class FakeOcr implements OcrEngine {
  calls = 0;
  constructor(
    private readonly text = "Invoice 4471 total due: $1,250.00\nPayment deadline is November 14",
    private readonly confidence = 0.95,
    private readonly fail = false,
  ) {}
  async recognize() {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.fail) throw new Error("engine crashed");
    return { text: this.text, confidence: this.confidence, ms: 5 };
  }
  async dispose() {}
}

export interface HarnessOpts {
  turns?: FakeTurn[];
  provider?: "anthropic" | "mock" | "none";
  settings?: Partial<Record<keyof Settings, unknown>>;
  ocr?: OcrEngine | null;
  secrets?: Partial<Record<SecretName, string>>;
}

/** A full AppCore wired to an in-memory DB, a fake Anthropic HTTP backend and fake STT sockets. */
export function harness(opts: HarnessOpts = {}) {
  const store = new Store(":memory:");
  const ff = fakeFetch(opts.turns ?? [{ text: ["Answer"] }]);
  const chat: ChatEvent[] = [];
  const transcript: TranscriptEvent[] = [];
  const app: AppEvent[] = [];
  const sockets: FakeSocket[] = [];
  const secretValues: Partial<Record<SecretName, string>> = { anthropic: "sk-ant-test-0000000000", deepgram: "dg-test-key", ...opts.secrets };
  const secrets = { get: (n: SecretName) => secretValues[n] ?? null, has: (n: SecretName) => !!secretValues[n] };
  let settings = applySettingsPatch(DEFAULT_SETTINGS, { onboardingComplete: true, consent: { screen: true, microphone: true, systemAudio: true }, ...opts.settings });
  const kind = opts.provider ?? "anthropic";
  const core = new AppCore(
    {
      store,
      secrets,
      ocr: opts.ocr === undefined ? new FakeOcr() : opts.ocr,
      emitChat: (e) => chat.push(e),
      emitTranscript: (e) => transcript.push(e),
      emitApp: (e) => app.push(e),
      providerFactory: () => {
        if (kind === "none") return null;
        if (kind === "mock") return new MockProvider(0);
        const client = new Anthropic({ apiKey: "sk-ant-test", fetch: ff.fetch as typeof fetch, maxRetries: 0 });
        return new AnthropicProvider({ apiKey: "x", client, retry: noSleep });
      },
      transcriptionFactory: (key) =>
        new DeepgramProvider(key, (url, protocols) => {
          const s = new FakeSocket(url, protocols);
          sockets.push(s);
          return s;
        }),
      ocrWaitMs: 2000,
    },
    settings,
    (s) => (settings = s),
  );
  const done = () => chat.filter((e) => e.type === "done");
  const ask = async (text: string, over: Record<string, unknown> = {}) => {
    const requestId = `r-${chat.length}-${Math.random().toString(36).slice(2)}`;
    await core.send({ requestId, conversationId: null, text, style: "quick", tone: "neutral", includeLiveTranscript: true, ...over });
    return chat.filter((e) => e.requestId === requestId);
  };
  const capture = (title = "Invoice") =>
    core.addCapture({ title, sourceId: `cap-${title}`, vision: { mediaType: "image/jpeg", data: Buffer.from(title).toString("base64") }, ocrPng: Buffer.from("png"), thumbnailDataUrl: "data:," }, { pending: false });
  return { store, core, ff, calls: ff.calls, chat, transcript, app, sockets, ask, done, capture, get settings() { return settings; } };
}
