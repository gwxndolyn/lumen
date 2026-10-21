// AudioWorklet: resamples each input to 16 kHz and converts to 16-bit PCM in ~100 ms frames.
// Input 0 = microphone, input 1 = system audio (optional). With `channels: 2` the output is
// interleaved [mic, system] so the recognizer can transcribe each source separately; mic and
// system audio are never mixed together. Also reports per-input RMS levels for the UI.
class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = (options && options.processorOptions && options.processorOptions.channels) || 1;
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.frame = 1600; // samples per channel per frame (100 ms)
    this.out = new Int16Array(this.frame * this.channels);
    this.n = 0;
    this.levels = [0, 0];
    this.levelCount = 0;
  }
  monoOf(input, len) {
    const mono = new Float32Array(len);
    if (!input || !input.length) return mono;
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / input.length;
    }
    return mono;
  }
  rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length || 1));
  }
  process(inputs) {
    const len = (inputs[0] && inputs[0][0] && inputs[0][0].length) || (inputs[1] && inputs[1][0] && inputs[1][0].length) || 128;
    const mic = this.monoOf(inputs[0], len);
    const sys = this.channels === 2 ? this.monoOf(inputs[1], len) : null;
    this.levels[0] = Math.max(this.levels[0], this.rms(mic));
    if (sys) this.levels[1] = Math.max(this.levels[1], this.rms(sys));
    while (this.pos < len) {
      const idx = Math.floor(this.pos);
      const a = Math.max(-1, Math.min(1, mic[idx]));
      if (this.channels === 2) {
        const b = Math.max(-1, Math.min(1, sys[idx]));
        this.out[this.n * 2] = a < 0 ? a * 0x8000 : a * 0x7fff;
        this.out[this.n * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
      } else {
        this.out[this.n] = a < 0 ? a * 0x8000 : a * 0x7fff;
      }
      this.n++;
      if (this.n === this.frame) {
        this.port.postMessage({ pcm: this.out.slice(0).buffer, levels: this.levels.slice(0) });
        this.levels = [0, 0];
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= len;
    return true;
  }
}
registerProcessor("pcm-worklet", PcmWorklet);
