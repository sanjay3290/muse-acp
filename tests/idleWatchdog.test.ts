import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleTimeout, IdleWatchdog } from "../src/util/idleWatchdog.js";
import { DEFAULT_TURN_IDLE_TIMEOUT_MS, resolveTurnIdleTimeoutMs } from "../src/util/env.js";

describe("IdleWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("expires after the timeout with no activity", async () => {
    const w = new IdleWatchdog(1000);
    const settled = w.expired.then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const e = await settled;
    expect(e).toBeInstanceOf(IdleTimeout);
    expect((e as IdleTimeout).timeoutMs).toBe(1000);
  });

  it("touch() restarts the countdown so an active turn never expires", async () => {
    const w = new IdleWatchdog(1000);
    let fired = false;
    w.expired.catch(() => (fired = true));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(900);
      w.touch();
    }
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toBe(true);
    w.dispose();
  });

  it("dispose() stops it for good", async () => {
    const w = new IdleWatchdog(1000);
    let fired = false;
    w.expired.catch(() => (fired = true));
    w.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    w.touch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toBe(false);
  });

  it("a timeout of 0 disables the watchdog", async () => {
    const w = new IdleWatchdog(0);
    let fired = false;
    w.expired.catch(() => (fired = true));
    expect(w.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fired).toBe(false);
  });
});

describe("resolveTurnIdleTimeoutMs", () => {
  const prev = process.env.MUSE_TURN_IDLE_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_TURN_IDLE_TIMEOUT_MS;
    else process.env.MUSE_TURN_IDLE_TIMEOUT_MS = prev;
  });

  it("defaults to ten minutes", () => {
    delete process.env.MUSE_TURN_IDLE_TIMEOUT_MS;
    expect(resolveTurnIdleTimeoutMs()).toBe(DEFAULT_TURN_IDLE_TIMEOUT_MS);
    expect(DEFAULT_TURN_IDLE_TIMEOUT_MS).toBe(600_000);
  });

  it("reads the env knob, accepts 0, and ignores garbage", () => {
    process.env.MUSE_TURN_IDLE_TIMEOUT_MS = "30000";
    expect(resolveTurnIdleTimeoutMs()).toBe(30_000);
    process.env.MUSE_TURN_IDLE_TIMEOUT_MS = "0";
    expect(resolveTurnIdleTimeoutMs()).toBe(0);
    process.env.MUSE_TURN_IDLE_TIMEOUT_MS = "soon";
    expect(resolveTurnIdleTimeoutMs()).toBe(DEFAULT_TURN_IDLE_TIMEOUT_MS);
    process.env.MUSE_TURN_IDLE_TIMEOUT_MS = "-5";
    expect(resolveTurnIdleTimeoutMs()).toBe(DEFAULT_TURN_IDLE_TIMEOUT_MS);
  });
});
