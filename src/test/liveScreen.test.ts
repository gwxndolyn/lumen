import { describe, expect, it } from "vitest";
import { LiveScreen } from "../core/liveScreen";
import { harness } from "./harness";

describe("live screen context", () => {
  it("never starts without consent and stops itself when consent is revoked", async () => {
    let permitted = false;
    let ticks = 0;
    const ls = new LiveScreen(async () => (ticks++, true), () => undefined, () => permitted);
    expect(() => ls.start(3)).toThrow(/off/);
    permitted = true;
    ls.start(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBe(1);
    permitted = false;
    ls.resume();
    (ls as unknown as { schedule(ms: number): void }).schedule(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ls.snapshot.active).toBe(false);
    expect(ticks).toBe(1);
  });

  it("replaces the previous live frame instead of accumulating captures", async () => {
    const h = harness();
    let frame = 0;
    (h.core as unknown as { deps: { liveScreenCapture: unknown } }).deps.liveScreenCapture = async () => ({
      title: "Display",
      sourceId: "screen:1",
      vision: { mediaType: "image/jpeg" as const, data: Buffer.from(`frame${frame++}`).toString("base64") },
      ocrPng: Buffer.from("x"),
      thumbnailDataUrl: "data:,",
    });
    h.core.startLiveScreen();
    await new Promise((r) => setTimeout(r, 60));
    await (h.core as unknown as { liveScreenTick(): Promise<void> }).liveScreenTick();
    const shots = h.core.engine.list(h.core.activeSessionId).filter((r) => r.source === "screenshot");
    expect(shots).toHaveLength(1);
    expect(shots[0]!.status).toBe("active");
    h.core.stopLiveScreen();
    expect(h.core.engine.list(h.core.activeSessionId)).toHaveLength(0);
    expect(h.core.liveScreenState.active).toBe(false);
  });
});
