/**
 * `prefill` — assistive cadastro extraction: the job queue and the suggestions an
 * attendant accepts or rejects. Owns `cadastro_prefill_job` and
 * `cadastro_prefill_suggestion` (`ownership.json`).
 *
 * The only file a composition root imports. It exports:
 *
 * - {@link createHttpPlugin}: the six routes, over the Omie adapter. Their paths
 *   are unchanged from `apps/api/src/prefill`.
 * - {@link createJobs}: ONE job, `prefill/enqueue-and-drain`, every
 *   `WORKER_PREFILL_POLL_MS` — the silence-window scan, then one drain. A poll,
 *   not a `message-received` subscription (4C ruling; see `enqueue-prefill`).
 *
 * Everything prefill writes on another module's tables goes through that
 * module's contracts: the customer and its fields through `customers`', the
 * thread link, the switch, the `should_reply` labels and the watermark through
 * `conversations`'.
 */
import type { Db } from "../../kernel/db.js";
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import type { RegisterJob } from "../../kernel/jobs.js";
import { createRoute as acceptAllPrefillRoute } from "./accept-all-prefill/index.js";
import { createRoute as acceptPrefillFieldRoute } from "./accept-prefill-field/index.js";
import { drainPrefill } from "./drain-prefill/index.js";
import { enqueueClosedWindows } from "./enqueue-prefill/index.js";
import { route as getPrefillRoute } from "./get-prefill/index.js";
import type { GeneratePrefillFields } from "./internal/extract.js";
import type { PrefillPorts } from "./internal/ports.js";
import { route as rejectPrefillFieldRoute } from "./reject-prefill-field/index.js";
import { route as retryPrefillRoute } from "./retry-prefill/index.js";
import { route as setExtractEnabledRoute } from "./set-extract-enabled/index.js";

/**
 * Prefill's HTTP plugin, over the given ports.
 *
 * @param ports - See {@link PrefillPorts}; one per app, in this closure.
 * @returns The plugin that registers prefill's six route slices.
 */
export function createHttpPlugin(ports: PrefillPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "prefill", "get-prefill", getPrefillRoute);
    registerSlice(app, "prefill", "accept-prefill-field", acceptPrefillFieldRoute(ports));
    registerSlice(app, "prefill", "accept-all-prefill", acceptAllPrefillRoute(ports));
    registerSlice(app, "prefill", "reject-prefill-field", rejectPrefillFieldRoute);
    registerSlice(app, "prefill", "retry-prefill", retryPrefillRoute);
    registerSlice(app, "prefill", "set-extract-enabled", setExtractEnabledRoute);
  };
}

/** The job's name, for the worker's failure-log map. */
export const ENQUEUE_AND_DRAIN_JOB = "prefill/enqueue-and-drain";

/**
 * The job's two steps as one port, so the worker's composition test can wrap
 * the real implementation and record the order it is driven in (as the old
 * worker test wrapped its prefill store).
 */
export type PrefillJobPort = {
  /** The silence-window scan: `enqueue-prefill`. */
  enqueue(now: Date): Promise<void>;
  /** One drain: `drain-prefill`. */
  drain(): Promise<void>;
};

/**
 * The job's port over a database handle.
 *
 * @param db - The database handle.
 * @param generate - The LLM backend; omitted uses the OpenAI one. Tests pass a fake.
 */
export function createPrefillJob(db: Db, generate?: GeneratePrefillFields): PrefillJobPort {
  return {
    enqueue: (now) => enqueueClosedWindows(db, now),
    drain: () => drainPrefill(db, generate),
  };
}

/** What the prefill job needs. */
export type PrefillJobDeps = {
  /** `WORKER_PREFILL_POLL_MS`; the job's interval. */
  everyMs: number;
} & (
  | { db: Db; prefill?: undefined }
  /** A port given outright; the worker passes one it built, its test a wrapped one. */
  | { db?: Db; prefill: PrefillJobPort }
);

/**
 * Registers ONE job: the silence-window scan, then one drain, in that order, as
 * the worker's `worker/prefill` job ran them.
 *
 * @param deps - See {@link PrefillJobDeps}.
 * @returns What the worker's registry calls.
 */
export function createJobs(deps: PrefillJobDeps): (register: RegisterJob) => void {
  const prefill = deps.prefill ?? createPrefillJob(deps.db as Db);
  return (register) =>
    register({
      name: ENQUEUE_AND_DRAIN_JOB,
      everyMs: deps.everyMs,
      run: async () => {
        await prefill.enqueue(new Date());
        await prefill.drain();
      },
    });
}

export { drainPrefill, sanitizePrefillError } from "./drain-prefill/index.js";
export { enqueueClosedWindows } from "./enqueue-prefill/index.js";
export type { GeneratePrefillFields } from "./internal/extract.js";
export type { PrefillPorts } from "./internal/ports.js";
