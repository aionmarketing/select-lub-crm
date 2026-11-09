/**
 * Job registration for worker slices.
 *
 * Today `apps/worker/src/worker.ts` holds one `setInterval` per loop plus an
 * in-flight flag so a slow tick is skipped rather than overlapped. A worker
 * slice declares the same thing — a name, an interval, and the work — and the
 * composition root starts them. The flag moves here so every loop has it, which
 * it does today only because each one remembered to.
 *
 * `run` receives only the registry's stop signal: a slice reaches its
 * dependencies the way an HTTP slice does, through what the composition root
 * bound. It is awaited, and a rejection is reported through `onError` rather
 * than becoming an unhandled rejection that takes the process down.
 *
 * The signal (background-oil-research D19) is aborted by `stop()` before it
 * waits out the ticks in flight, so a job that can run for minutes — a research
 * run waiting on a model — can release its claim at once instead of holding
 * shutdown. A job that ignores it behaves as before.
 */

/** One registered loop. */
export interface Job {
  /** `<module>/<slice>`, e.g. `channel/drain-outbox`. Used in logs. */
  readonly name: string;
  /** Tick interval in milliseconds. */
  readonly everyMs: number;
  /**
   * The work for one tick. `signal` is aborted when the registry stops; the
   * tick's promise is still awaited, so a job that listens to it must settle
   * only once whatever it writes on abort has committed.
   */
  readonly run: (signal: AbortSignal) => Promise<void>;
}

/** What a module's `jobs(register)` is handed. */
export type RegisterJob = (job: Job) => void;

/** A started set of loops. */
export interface RunningJobs {
  /**
   * Stops every timer at once, aborts the signal every tick was handed, then
   * resolves when every tick already in flight has settled. A tick is not cut
   * off: one that ignores the signal runs to its end, as before.
   *
   * The wait is what lets a composition root shut down in order: a drain tick
   * finishing a send during shutdown still needs its event subscribers and its
   * database client, so the caller awaits this before removing either. It never
   * rejects; a tick's failure was already reported through `onError`.
   */
  stop(): Promise<void>;
}

/** How a tick's failure is reported. Defaults to `console.error`. */
export type JobErrorReporter = (name: string, error: unknown) => void;

/**
 * Wraps `run` so a call made while the previous one is still running is
 * skipped, for work that also runs outside the registry. The worker's
 * start-up reconcile is one: a heartbeat must not issue a second GET while
 * that one is in flight. Lifted from `startWorker`'s own flag in wave 5.2.
 *
 * @param run - The work; it reports its own failures.
 * @returns A function that resolves at once when a run is in flight.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await run();
    } finally {
      inFlight = false;
    }
  };
}

/** A failure as the worker's log lines have always spelled it. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

/**
 * Runs a one-shot start-up task, logging `<label> start`, then `<label> done`
 * or `<label> failed <message>`. It never rejects. The worker's Omie pull and
 * history backfill at start each spelled this out; lifted in wave 5.2.
 */
export function runOnce(label: string, log: (message: string) => void, run: () => Promise<void>): Promise<void> {
  log(`${label} start`);
  return run().then(
    () => {
      log(`${label} done`);
    },
    (error: unknown) => {
      log(`${label} failed ${messageOf(error)}`);
    },
  );
}

/**
 * The worker's shutdown, in order: log, stop the jobs and wait out the ticks in
 * flight, run `after` (unsubscribe, disconnect), then `exit(0)` however `after`
 * settles. A second call is ignored. Lifted from `startWorker` in wave 5.2.
 */
export function createStop(options: {
  running: RunningJobs;
  log: (message: string) => void;
  after: () => unknown;
  exit: (code: number) => void;
}): (signal: string) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) return;
    stopping = true;
    options.log(`worker stopping (${signal})`);
    // The timers stop at once; a tick already in flight is waited for. A drain
    // finishing a send here still publishes outbound-sent, so the subscribers
    // come off, and the shared client disconnects, only after every tick is done.
    void options.running
      .stop()
      .then(options.after)
      .finally(() => options.exit(0));
  };
}

/**
 * Collects jobs from every module, then starts them.
 *
 * @returns `register` to hand to each module's `jobs(register)`, and `start`.
 */
export function createJobRegistry(): {
  register: RegisterJob;
  start(options?: { onError?: JobErrorReporter }): RunningJobs;
  readonly registered: readonly Job[];
} {
  const jobs: Job[] = [];
  return {
    register: (job) => {
      if (jobs.some((existing) => existing.name === job.name)) {
        throw new Error(`job registered twice: ${job.name}`);
      }
      jobs.push(job);
    },
    get registered() {
      return jobs;
    },
    start(options = {}) {
      const onError =
        options.onError ?? ((name: string, error: unknown) => console.error(`job ${name} failed`, error));
      // The tick each job has in flight, if any; `stop` waits on these.
      const inFlight = new Map<string, Promise<void>>();
      // One signal for every tick of this start: `stop` aborts it first.
      const stopping = new AbortController();
      const timers = jobs.map((job) => {
        // One tick at a time per job: the worker is single-machine, and a drain
        // that overruns its interval must not start a second copy of itself.
        const timer = setInterval(() => {
          if (inFlight.has(job.name) || stopping.signal.aborted) return;
          const tick = job
            .run(stopping.signal)
            .catch((error: unknown) => onError(job.name, error))
            .finally(() => {
              inFlight.delete(job.name);
            });
          inFlight.set(job.name, tick);
        }, job.everyMs);
        // Do not hold the process open on this timer alone.
        timer.unref?.();
        return timer;
      });
      return {
        stop: async () => {
          for (const timer of timers) clearInterval(timer);
          stopping.abort(new DOMException("the worker is stopping", "AbortError"));
          await Promise.allSettled([...inFlight.values()]);
        },
      };
    },
  };
}
