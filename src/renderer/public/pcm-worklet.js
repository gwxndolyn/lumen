// AudioWorklet: downmix to mono, resample to 16 kHz, convert to 16-bit PCM, post ~100 ms frames.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const len = input[0].length;
    const mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / input.length;
    }
    while (this.pos < len) {
      const s = Math.max(-1, Math.min(1, mono[Math.floor(this.pos)]));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.slice(0).buffer, []);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= len;
    return true;
  }
}
registerProcessor("pcm-worklet", PcmWorklet);
