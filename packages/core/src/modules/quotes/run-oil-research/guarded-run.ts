/**
 * The frame every claimed run executes in (background-oil-research D9, D19): one signal, a
 * lease-renewing `step`, and the release written as the worker stops.
 *
 * - **One signal**, `AbortSignal.any([stop, ceiling, lost])`, threaded into the model, search,
 *   page-fetch and picker calls through the ports.
 * - **`step`**: before each port call, the lease is renewed and the meter flushed to the run row,
 *   in one short compare-and-set transaction. A lost one aborts the run: nothing more is written.
 * - **The release is written when `stop` aborts**, without waiting for the pipeline, and
 *   {@link GuardedRun.settle} awaits it, so the tick settles only after it committed and the
 *   worker's `after` never disconnects the client under it. It waits only for the calls already in
 *   flight to settle their spend (bounded by {@link RELEASE_SETTLE_MS}): the abort makes each one
 *   report its charge to the meter, and a release written before that would leave the charge out of
 *   `oil_research_run.cost_usd` and the day's spend (review of #217).
 */
import type { Db } from "../../../kernel/db.js";
import { createUsageMeter, type UsageMeter } from "../internal/model-calls/meter.js";
import type { ResearchStage } from "../internal/research/ports.js";
import type { RunProgress } from "../internal/research/run-progress.js";
import type { DbClient } from "@select-lub/core/db";

/** Why a run stopped before its pipeline answered. */
export class RunInterrupted extends Error {
  override name = "RunInterrupted";
  constructor(readonly why: "stopped" | "ceiling" | "lost") {
    super(`research run ${why}`);
  }
}

/**
 * The longest the release waits for the calls in flight to settle their spend after a stop. An
 * aborted call settles in milliseconds, but a retry's wait is not abortable and can last up to 10 s
 * (`OPENAI_RETRY_MAX_WAIT_MS`); this stays well under the worker's 30 s `kill_timeout`, so the
 * release still commits before the machine is killed.
 */
export const RELEASE_SETTLE_MS = 10_000;

/** The claim's own compare-and-set writes. */
export type ClaimWrites = {
  renew(tx: DbClient, now: Date, progress: RunProgress): Promise<boolean>;
  release(tx: DbClient, now: Date, progress: RunProgress): Promise<boolean>;
};

/** A run in its frame. */
export type GuardedRun = {
  meter: UsageMeter;
  signal: AbortSignal;
  step<T>(stage: ResearchStage | null, fn: () => Promise<T>): Promise<T>;
  progress(): RunProgress;
  /** Why the run was interrupted, or null. `stopped` outranks `lost`, which outranks `ceiling`. */
  interrupted(): "stopped" | "ceiling" | "lost" | null;
  /** Awaits the release (when the worker stopped) and clears the ceiling. Always call it. */
  settle(): Promise<{ released: boolean }>;
};

/**
 * @param db - The database handle.
 * @param writes - The claim's renew and release.
 * @param options.stop - The job's stop signal.
 * @param options.ceilingMs - The run ceiling (D2).
 * @param options.now - The clock.
 * @param options.meter - An existing meter to keep counting on (a Tecfil step after a verified run).
 * @param options.settleMs - How long a stop's release waits for calls in flight; {@link RELEASE_SETTLE_MS}.
 */
export function guardRun(
  db: Db,
  writes: ClaimWrites,
  options: { stop: AbortSignal; ceilingMs: number; now: () => Date; meter?: UsageMeter; stageMs?: Record<string, number>; settleMs?: number },
): GuardedRun {
  const meter = options.meter ?? createUsageMeter();
  const stageMs = options.stageMs ?? {};
  const ceiling = new AbortController();
  const lost = new AbortController();
  const timer = setTimeout(() => ceiling.abort(new RunInterrupted("ceiling")), options.ceilingMs);
  timer.unref?.();
  const signal = AbortSignal.any([options.stop, ceiling.signal, lost.signal]);
  const progress = (): RunProgress => ({ meter: meter.snapshot(), stageMs: { ...stageMs } });

  /** The `step` calls that have not settled yet: what a stop's release waits for. */
  const inflight = new Set<Promise<unknown>>();
  /** Whether every call in flight settled within `ms`. */
  const inflightSettled = async (ms: number): Promise<boolean> => {
    if (inflight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.allSettled([...inflight]).then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  let release: Promise<boolean> | null = null;
  const onStop = () => {
    // Written once the calls in flight have settled their spend. The stop aborted them, so that is
    // milliseconds, not the whole web budget a search tool call may hold the pipeline for (D19).
    release ??= (async () => {
      if (!(await inflightSettled(options.settleMs ?? RELEASE_SETTLE_MS))) {
        console.warn("oil-research", JSON.stringify({ outcome: "release_before_settle", why: "a call in flight did not settle in time; its spend may be missing" }));
      }
      return db.tx("quotes", (tx) => writes.release(tx, options.now(), progress()));
    })().catch((error: unknown) => {
      console.error("oil-research", JSON.stringify({ outcome: "release_failed", error: String(error).slice(0, 200) }));
      return false;
    });
  };
  if (options.stop.aborted) onStop();
  else options.stop.addEventListener("abort", onStop, { once: true });

  const interrupted = () => (options.stop.aborted ? "stopped" : lost.signal.aborted ? "lost" : ceiling.signal.aborted ? "ceiling" : null);

  return {
    meter,
    signal,
    progress,
    interrupted,
    async step(stage, fn) {
      const why = interrupted();
      if (why) throw new RunInterrupted(why);
      const held = await db.tx("quotes", (tx) => writes.renew(tx, options.now(), progress()));
      if (!held) {
        lost.abort(new RunInterrupted("lost"));
        throw new RunInterrupted("lost");
      }
      const started = Date.now();
      const running = (async () => fn())();
      inflight.add(running);
      const done = () => void inflight.delete(running);
      running.then(done, done);
      try {
        return await running;
      } finally {
        if (stage) stageMs[stage] = (stageMs[stage] ?? 0) + (Date.now() - started);
      }
    },
    async settle() {
      clearTimeout(timer);
      options.stop.removeEventListener("abort", onStop);
      return { released: release ? await release : false };
    },
  };
}
