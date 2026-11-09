/**
 * Test design (testing-strategy)
 *
 * SUT: the three helpers wave 5.2 lifted out of `startWorker` —
 *   `singleFlight`, `runOnce`, `createStop`. Pure: functions and promises, no
 *   timers, no database.
 *
 * Oracle: the behaviour `startWorker` had inline, which `apps/worker/test/
 *   worker.test.ts` still pins end to end:
 *   - reconcile keeps its own flag — a call while one runs issues no second run;
 *   - the Omie pull and history backfill at start log `<label> start`, then
 *     `<label> done` or `<label> failed <message>`, and never reject;
 *   - stop logs once, waits for the jobs, runs the teardown, then exits 0; a
 *     second stop does nothing. (A rejecting teardown still exits, through
 *     `finally`, and leaves its rejection unhandled as before; not tested here,
 *     because vitest fails any run with an unhandled rejection.)
 *
 * Decision map
 *   singleFlight: in flight T → skipped (run count stays 1); F → runs again
 *   runOnce: run resolves → `done`; rejects with Error → `failed <message>`;
 *     rejects with a non-Error → `failed unknown`
 *   createStop: first call → log, stop, after, exit(0); second call → nothing
 */
import { describe, expect, it, vi } from "vitest";
import { createStop, runOnce, singleFlight, type RunningJobs } from "./jobs.js";

describe("singleFlight", () => {
  it("skips a call made while the previous one runs, and runs again once it settles", async () => {
    let runs = 0;
    let release!: () => void;
    const guarded = singleFlight(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = guarded();
    await guarded();
    expect(runs).toBe(1);

    release();
    await first;
    const third = guarded();
    expect(runs).toBe(2);
    release();
    await third;
  });
});

describe("runOnce", () => {
  it("logs start then done when the task resolves", async () => {
    const lines: string[] = [];
    await runOnce("omie pull", (m) => lines.push(m), async () => {});
    expect(lines).toEqual(["omie pull start", "omie pull done"]);
  });

  it("logs the failure's message and does not reject", async () => {
    const lines: string[] = [];
    await expect(
      runOnce("history backfill", (m) => lines.push(m), async () => {
        throw new Error("evolution down");
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual(["history backfill start", "history backfill failed evolution down"]);
  });

  it("names a non-Error rejection 'unknown'", async () => {
    const lines: string[] = [];
    await runOnce("omie pull", (m) => lines.push(m), () => Promise.reject("nope"));
    expect(lines).toEqual(["omie pull start", "omie pull failed unknown"]);
  });
});

describe("createStop", () => {
  function running(order: string[]): RunningJobs {
    return {
      stop: async () => {
        order.push("jobs stopped");
      },
    };
  }

  it("logs, stops the jobs, runs the teardown, then exits 0 — once", async () => {
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    const stop = createStop({
      running: running(order),
      log: (m) => order.push(m),
      after: () => order.push("after"),
      exit,
    });

    stop("SIGTERM");
    stop("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(order).toEqual(["worker stopping (SIGTERM)", "jobs stopped", "after", "exit 0"]);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
