import { api } from "./api";

/**
 * Captures microphone (and optionally system audio, where the OS supports loopback), mixes them,
 * converts to 16 kHz mono PCM in an AudioWorklet and streams frames to the main process.
 * Runs in the overlay renderer, which stays alive while hidden.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private node: AudioWorkletNode | null = null;

  get active() {
    return this.ctx !== null;
  }

  async start(micDeviceId: string | null, systemAudio: boolean) {
    await this.stop();
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      this.streams.push(mic);
      if (systemAudio) {
        try {
          // The main process answers with loopback audio; video is discarded immediately.
          const sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
          sys.getVideoTracks().forEach((t) => t.stop());
          if (sys.getAudioTracks().length) this.streams.push(sys);
        } catch {
          // System audio is optional — continue with microphone only.
        }
      }
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", document.baseURI).href);
      this.node = new AudioWorkletNode(this.ctx, "pcm-worklet");
      this.node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => api.transcriptAudio(new Uint8Array(ev.data));
      for (const s of this.streams) this.ctx.createMediaStreamSource(s).connect(this.node);
      // Worklet must be pulled by the graph; route through a muted gain so nothing is played back.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
    } catch (err) {
      await this.stop();
      const name = (err as DOMException)?.name;
      const msg =
        name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in Permissions (and in your OS privacy settings)."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "The selected microphone was not found."
            : (err as Error).message;
      api.transcriptCaptureFailed(msg);
    }
  }

  async stop() {
    this.node?.disconnect();
    this.node = null;
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}
