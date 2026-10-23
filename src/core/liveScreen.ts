import type { LiveScreenState } from "../shared/types";

/** Result of one sampling tick. */
export type TickResult = "captured" | "unchanged";

/** Errors whose cause the user must fix (no automatic retry). */
export class LiveScreenFatal extends Error {
  constructor(
    message: string,
    readonly status: "permission_required" | "unsupported",
  ) {
    super(message);
  }
}

const MAX_FAILURES = 5;
const MAX_INTERVAL_SEC = 60;

/**
 * Explicitly started, periodic screen sampling. Never starts by itself; it stops when screen
 * consent is revoked, and each tick replaces (not accumulates) the previous live capture.
 *
 * Lifecycle: inactive → active ⇄ paused; active → recovering (transient failures, bounded backoff)
 * → active, or → failed after MAX_FAILURES; permission_required / unsupported stop sampling and
 * need the user. Every start() begins a new run; work from an earlier run (a capture that was
 * still in flight when the user stopped or switched session) is discarded via `isCurrent(run)`.
 */
export class LiveScreen {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: LiveScreenState = {
    active: false,
    paused: false,
    intervalSec: 10,
    lastCaptureAt: null,
    lastError: null,
    captures: 0,
    skipped: 0,
    status: "inactive",
    failures: 0,
    effectiveIntervalSec: 10,
    discarded: 0,
  };
  private busy = false;
  private run = 0;
  /** Consecutive unchanged frames (drives adaptive backoff). */
  private unchangedStreak = 0;

  constructor(
    private readonly tick: (run: number) => Promise<TickResult>,
    private readonly emit: (s: LiveScreenState) => void,
    private readonly isPermitted: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  get snapshot(): LiveScreenState {
    return { ...this.state };
  }

  isCurrent(run: number): boolean {
    return this.state.active && !this.state.paused && run === this.run;
  }

  /** Count work that finished after it was superseded (diagnostics). */
  noteDiscarded() {
    this.state.discarded++;
  }

  start(intervalSec: number) {
    if (!this.isPermitted()) throw new Error("Screen context is off. Enable it in Permissions.");
    // Idempotent: starting a running sampler only updates its interval.
    if (this.state.active && !this.state.paused) {
      this.state.intervalSec = intervalSec;
      this.state.effectiveIntervalSec = Math.max(intervalSec, this.state.effectiveIntervalSec);
      this.emit(this.snapshot);
      return;
    }
    this.run++;
    this.unchangedStreak = 0;
    this.state = { ...this.state, active: true, paused: false, intervalSec, effectiveIntervalSec: intervalSec, lastError: null, status: "active", failures: 0 };
    this.schedule(0);
    this.emit(this.snapshot);
  }

  pause() {
    if (!this.state.active || this.state.paused) return;
    this.state.paused = true;
    this.state.status = "paused";
    this.clear();
    this.run++; // a capture in flight finishes into a run that no longer exists
    this.emit(this.snapshot);
  }

  resume() {
    if (!this.state.active || !this.state.paused) return;
    if (!this.isPermitted()) return this.halt("permission_required", "Screen context is off. Enable it in Permissions.");
    this.state.paused = false;
    this.state.status = "active";
    this.state.failures = 0;
    this.unchangedStreak = 0;
    this.schedule(0);
    this.emit(this.snapshot);
  }

  /** Something on screen probably changed (display added/removed, wake): sample soon. */
  nudge() {
    if (!this.state.active || this.state.paused || this.busy) return;
    this.unchangedStreak = 0;
    this.state.effectiveIntervalSec = this.state.intervalSec;
    this.schedule(500);
  }

  stop() {
    this.clear();
    const was = this.state.active;
    const keep = this.state.status === "permission_required" || this.state.status === "unsupported" || this.state.status === "failed";
    this.state = { ...this.state, active: false, paused: false, status: keep && !was ? this.state.status : "inactive" };
    if (was) this.run++; // anything in flight belongs to a finished run
    this.emit(this.snapshot);
  }

  private halt(status: "permission_required" | "unsupported" | "failed", message: string) {
    this.clear();
    this.state = { ...this.state, active: false, paused: false, status, lastError: message };
    this.run++;
    this.emit(this.snapshot);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.clear();
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    if (!this.state.active || this.state.paused) return;
    if (!this.isPermitted()) return this.halt("permission_required", "Screen consent was revoked.");
    // A tick still running (slow capture/OCR) is not overlapped: backpressure, not a queue.
    if (this.busy) return this.schedule(this.state.effectiveIntervalSec * 1000);
    this.busy = true;
    const run = this.run;
    try {
      const r = await this.tick(run);
      if (run !== this.run) return; // stopped, paused/resumed or restarted meanwhile
      if (r === "captured") {
        this.state.lastCaptureAt = this.now();
        this.state.captures++;
        this.unchangedStreak = 0;
      } else {
        this.state.skipped++;
        this.unchangedStreak++;
      }
      this.state.failures = 0;
      this.state.status = "active";
      this.state.lastError = null;
      // Adaptive sampling: an unchanged screen is checked less often (up to 4× the interval, ≤ 60 s).
      const factor = this.unchangedStreak >= 6 ? 4 : this.unchangedStreak >= 3 ? 2 : 1;
      this.state.effectiveIntervalSec = Math.min(MAX_INTERVAL_SEC, Math.max(this.state.intervalSec, this.state.intervalSec * factor));
    } catch (err) {
      if (run !== this.run) return;
      if (err instanceof LiveScreenFatal) return this.halt(err.status, err.message);
      this.state.failures++;
      this.state.lastError = (err as Error).message;
      if (this.state.failures >= MAX_FAILURES) return this.halt("failed", `Live screen context stopped after ${MAX_FAILURES} failed captures: ${(err as Error).message}`);
      this.state.status = "recovering";
      // Bounded backoff: interval × 2^failures, capped.
      this.state.effectiveIntervalSec = Math.min(MAX_INTERVAL_SEC, this.state.intervalSec * 2 ** this.state.failures);
    } finally {
      this.busy = false;
    }
    this.emit(this.snapshot);
    if (this.state.active && !this.state.paused && run === this.run) this.schedule(this.state.effectiveIntervalSec * 1000);
  }
}
