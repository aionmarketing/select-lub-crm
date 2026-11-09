/**
 * The erp module: the transport to the ERP. It owns `sync_execution`,
 * `integration_error` and `erp_outbox`, and is the only thing that talks to the
 * ERP (design D7). `run-pull` pulls; `drain-outbox` pushes. The only file the
 * composition roots import.
 *
 * No HTTP: nothing reads sync runs over the API, so no route was invented
 * (`list-sync-executions` became the pull's internal watermark read, 3A.3).
 *
 * `createJobs(deps)` returns the module's jobs for the worker's registry
 * (W3-C2); the worker does not call it yet, because `drain-outbox` has nothing
 * to drain until 4B enqueues (W3-C8: `services` never does). The pull is not a job: the worker drives it
 * through `startWorker`'s `runOmiePull` option and its `WORKER_OMIE_*` flags,
 * passing {@link runPull}.
 */
import type { RegisterJob } from "../../kernel/jobs.js";
import { job as drainOutboxJob, type DrainErpOutboxDeps } from "./drain-outbox/index.js";

export { enqueueErpWrite, type ErpWrite, type QueuedErpWrite } from "./contracts/enqueue-write.js";
export { createSyncRunRecorder } from "./contracts/record-sync-run.js";
export { runPull } from "./run-pull/index.js";
export type { DrainErpOutboxDeps };

/**
 * The module's worker jobs.
 *
 * @param deps - The database handle and the ERP port, held in the closure.
 * @returns A function that registers `erp/drain-outbox`.
 */
export function createJobs(deps: DrainErpOutboxDeps): (register: RegisterJob) => void {
  return (register) => register(drainOutboxJob(deps));
}
