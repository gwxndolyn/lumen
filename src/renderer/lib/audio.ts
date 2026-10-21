import type { AudioInputState } from "../../shared/types";
import { api } from "./api";

/**
 * Captures the selected microphone and — only when separately authorized — system audio, and
 * streams 16 kHz PCM frames to the main process. Microphone and system audio are independent
 * inputs: mic failure stops transcription, system-audio failure only disables that channel.
 * Runs in the overlay renderer, which stays alive (unthrottled) while hidden.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private sys: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sysNode: MediaStreamAudioSourceNode | null = null;
  private state: AudioInputState = { micLabel: null, systemAudio: "off", micLevel: 0, systemLevel: 0, silentForMs: 0 };
  private lastReport = 0;
  private lastSound = 0;
  private channels: 1 | 2 = 1;

  get active() {
    return this.ctx !== null;
  }

  private report(force = false) {
    const now = performance.now();
    if (!force && now - this.lastReport < 250) return;
    this.lastReport = now;
    api.transcriptAudioState({ ...this.state, silentForMs: this.lastSound ? Math.round(now - this.lastSound) : 0 });
  }

  async start(micDeviceId: string | null, systemAudio: boolean) {
    await this.stop();
    this.channels = systemAudio ? 2 : 1;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: micDeviceId ? { exact: micDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (err) {
      await this.stop();
      const name = (err as DOMException)?.name;
      const msg =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was denied. Allow Lumen in Permissions and in your OS privacy settings."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "The selected microphone is not available. Choose another one in Settings."
            : name === "NotReadableError"
              ? "The microphone is in use by another app or could not be opened."
              : (err as Error).message;
      api.transcriptCaptureFailed(msg, "microphone");
      return;
    }
    const track = this.mic.getAudioTracks()[0];
    this.state.micLabel = track?.label || "Microphone";
    // Detect the device being unplugged or revoked mid-session.
    track?.addEventListener("ended", () => api.transcriptCaptureFailed("The microphone was disconnected.", "microphone"));

    if (systemAudio) {
      try {
        // The main process answers with loopback audio; the video track is discarded immediately.
        this.sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        this.sys.getVideoTracks().forEach((t) => t.stop());
        if (!this.sys.getAudioTracks().length) throw new Error("no system audio track");
        this.state.systemAudio = "active";
        this.sys.getAudioTracks()[0]!.addEventListener("ended", () => {
          this.state.systemAudio = "unavailable";
          this.report(true);
        });
      } catch (err) {
        this.sys = null;
        const denied = (err as DOMException)?.name === "NotAllowedError";
        this.state.systemAudio = denied ? "denied" : "unavailable";
        api.transcriptCaptureFailed(denied ? "permission denied" : "this system does not provide system audio", "system");
      }
    }

    try {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", document.baseURI).href);
      this.node = new AudioWorkletNode(this.ctx, "pcm-worklet", { numberOfInputs: 2, processorOptions: { channels: this.channels } });
      this.node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; levels: number[] }>) => {
        api.transcriptAudio(new Uint8Array(ev.data.pcm));
        this.state.micLevel = Math.min(1, (ev.data.levels[0] ?? 0) * 4);
        this.state.systemLevel = Math.min(1, (ev.data.levels[1] ?? 0) * 4);
        if (this.state.micLevel > 0.02 || this.state.systemLevel > 0.02) this.lastSound = performance.now();
        this.report();
      };
      this.ctx.createMediaStreamSource(this.mic).connect(this.node, 0, 0);
      if (this.sys) {
        this.sysNode = this.ctx.createMediaStreamSource(this.sys);
        this.sysNode.connect(this.node, 0, 1);
      }
      // The worklet must be pulled by the graph; route through a muted gain so nothing is played back.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
      this.lastSound = performance.now();
      this.report(true);
    } catch (err) {
      await this.stop();
      api.transcriptCaptureFailed(`Audio processing could not start: ${(err as Error).message}`, "microphone");
    }
  }

  /** Stop only the system-audio input (consent revoked); the mic keeps going on channel 0. */
  stopSystem() {
    this.sysNode?.disconnect();
    this.sysNode = null;
    this.sys?.getTracks().forEach((t) => t.stop());
    this.sys = null;
    if (this.state.systemAudio === "active") this.state.systemAudio = "off";
    this.report(true);
  }

  async stop() {
    this.node?.disconnect();
    this.node = null;
    this.sysNode = null;
    for (const s of [this.mic, this.sys]) s?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.sys = null;
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.state = { micLabel: null, systemAudio: "off", micLevel: 0, systemLevel: 0, silentForMs: 0 };
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}
