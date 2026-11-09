/**
 * Test design (testing-strategy)
 *
 * SUT: `createJobRegistry().start()` — the per-job overlap guard and `stop()`.
 *   Pure: `setInterval` is faked, jobs are functions, no database.
 *
 * Oracle: kernel README ("one tick at a time"; `stop()` stops every timer and
 *   resolves once every tick in flight has settled). The shutdown order it
 *   serves: the worker awaits `stop()` before removing its event subscribers and
 *   disconnecting Prisma, so a send finishing during shutdown still reaches its
 *   subscriber (3A-channel review, item 3).
 *
 * Cases: a tick held open — `stop()` stays pending until it settles, and no
 *   further tick starts after `stop()`; nothing in flight — `stop()` resolves at
 *   once; a tick that rejects — reported through `onError`, and `stop()` still
 *   resolves (it never rejects). Mutation-checked: returning without awaiting
 *   the in-flight ticks fails the first case.
 *
 * The stop signal (background-oil-research D19, task 3.1): the signal a tick is
 *   handed is aborted by `stop()` BEFORE it waits — a tick that listens settles
 *   on it and `stop()` resolves then; a tick that ignores it is still waited out
 *   to its end, as before. Mutation-checked: aborting after the wait, or not at
 *   all, leaves the listening tick hanging and fails the first signal case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobRegistry } from "./jobs.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A promise and the function that settles it. */
function gate() {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release };
}

describe("createJobRegistry", () => {
  it("resolves stop() only after the tick in flight has finished, and starts no tick after it", async () => {
    const { hold, release } = gate();
    let started = 0;
    let finished = 0;
    const registry = createJobRegistry();
    registry.register({
      name: "test/held",
      everyMs: 10,
      run: async () => {
        started += 1;
        await hold;
        finished += 1;
      },
    });
    const running = registry.start();
    vi.advanceTimersByTime(10);
    expect(started).toBe(1);

    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(started).toBe(1);

    release();
    await stopping;
    expect(finished).toBe(1);
    expect(stopped).toBe(true);
  });

  it("resolves stop() at once when nothing is in flight", async () => {
    const run = vi.fn(async () => undefined);
    const registry = createJobRegistry();
    registry.register({ name: "test/idle", everyMs: 10, run });

    await registry.start().stop();

    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a failed tick through onError and still resolves stop()", async () => {
    const errors: string[] = [];
    const registry = createJobRegistry();
    registry.register({
      name: "test/fails",
      everyMs: 10,
      run: async () => {
        throw new Error("tick boom");
      },
    });
    const running = registry.start({
      onError: (name, error) => errors.push(`${name}: ${(error as Error).message}`),
    });
    vi.advanceTimersByTime(10);

    await expect(running.stop()).resolves.toBeUndefined();
    expect(errors).toEqual(["test/fails: tick boom"]);
  });

  it("aborts the tick's signal on stop(), before it waits, so a listening tick can settle", async () => {
    const seen: AbortSignal[] = [];
    let settledOnAbort = false;
    const registry = createJobRegistry();
    registry.register({
      name: "test/listens",
      everyMs: 10,
      run: (signal) => {
        seen.push(signal);
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            settledOnAbort = true;
            resolve();
          });
        });
      },
    });
    const running = registry.start();
    vi.advanceTimersByTime(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(false);

    await running.stop();
    expect(seen[0]!.aborted).toBe(true);
    expect(settledOnAbort).toBe(true);
  });

  it("still waits out a tick that ignores the signal", async () => {
    const { hold, release } = gate();
    let finished = false;
    const registry = createJobRegistry();
    registry.register({
      name: "test/ignores",
      everyMs: 10,
      run: async () => {
        await hold;
        finished = true;
      },
    });
    const running = registry.start();
    vi.advanceTimersByTime(10);
    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });
});
