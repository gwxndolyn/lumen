import type { LiveScreenState } from "../shared/types";

/**
 * Explicitly started, periodic screen sampling. Never starts by itself; it stops immediately when
 * screen consent is revoked, and each tick replaces (not accumulates) the previous live capture.
 */
export class LiveScreen {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: LiveScreenState = { active: false, paused: false, intervalSec: 10, lastCaptureAt: null, lastError: null, captures: 0 };
  private busy = false;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly emit: (s: LiveScreenState) => void,
    private readonly isPermitted: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  get snapshot(): LiveScreenState {
    return { ...this.state };
  }

  start(intervalSec: number) {
    if (!this.isPermitted()) throw new Error("Screen context is off. Enable it in Permissions.");
    this.state = { ...this.state, active: true, paused: false, intervalSec, lastError: null };
    this.schedule(0);
    this.emit(this.snapshot);
  }

  pause() {
    if (!this.state.active) return;
    this.state.paused = true;
    this.clear();
    this.emit(this.snapshot);
  }

  resume() {
    if (!this.state.active || !this.state.paused) return;
    this.state.paused = false;
    this.schedule(0);
    this.emit(this.snapshot);
  }

  stop() {
    this.clear();
    this.state = { ...this.state, active: false, paused: false };
    this.emit(this.snapshot);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.clear();
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async run() {
    if (!this.state.active || this.state.paused) return;
    if (!this.isPermitted()) {
      this.state.lastError = "Screen consent was revoked.";
      this.stop();
      return;
    }
    if (!this.busy) {
      this.busy = true;
      try {
        await this.tick();
        this.state.lastCaptureAt = this.now();
        this.state.captures++;
        this.state.lastError = null;
      } catch (err) {
        this.state.lastError = (err as Error).message;
      } finally {
        this.busy = false;
      }
      this.emit(this.snapshot);
    }
    if (this.state.active && !this.state.paused) this.schedule(this.state.intervalSec * 1000);
  }
}
