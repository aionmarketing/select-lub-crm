/**
 * `scheduling` — messages sent later: Programar mensagem on a conversation, and
 * the reminder messages hung off a vehicle return. Owns `scheduled_message` and
 * `return_reminder_message` (`ownership.json`).
 *
 * The only file a composition root imports. It exports:
 *
 * - {@link createHttpPlugin}: the ten routes, over the LIVE channel probe. Their
 *   paths are unchanged from `apps/api/src/{scheduled,return-reminders}`. Two of
 *   them, archive and unarchive, write `services`' `vehicle_return` through a
 *   stub contract (3B, ruling Q1-a).
 * - {@link createScheduledDue} and {@link createJobs}: the worker's due tick and
 *   outcome sync, registered as ONE job, `scheduling/due-and-sync`, so the two
 *   steps that write `scheduled_message` never run side by side (ruling Q4).
 * - `contracts/`: the three reminder-row writes `services` makes (3C), reached
 *   as `@select-lub/core/modules/scheduling/contracts`.
 */
import type { Db } from "../../kernel/db.js";
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import type { RegisterJob } from "../../kernel/jobs.js";
import { route as archiveVehicleReturnRoute } from "./archive-vehicle-return/index.js";
import { route as cancelReturnReminderRoute } from "./cancel-return-reminder/index.js";
import { createRoute as cancelScheduledMessageRoute } from "./cancel-scheduled-message/index.js";
import { createRoute as createReturnReminderRoute } from "./create-return-reminder/index.js";
import { createRoute as createScheduledMessageRoute } from "./create-scheduled-message/index.js";
import { route as getScheduledMessageRoute } from "./get-scheduled-message/index.js";
import type { ScheduledDue } from "./internal/due-port.js";
import type { SchedulingPorts } from "./internal/ports.js";
import { route as listScheduledMessagesRoute } from "./list-scheduled-messages/index.js";
import { dispatchDue, recoverStaleProcessing, runDueTick } from "./run-due-tick/index.js";
import { route as suggestScheduleDateRoute } from "./suggest-schedule-date/index.js";
import { syncOutboxOutcomes, syncScheduled } from "./sync-scheduled/index.js";
import { route as unarchiveVehicleReturnRoute } from "./unarchive-vehicle-return/index.js";
import { createRoute as updateReturnReminderRoute } from "./update-return-reminder/index.js";

/**
 * Scheduling's HTTP plugin, over the given ports.
 *
 * The probe lives in this closure, one per app: two apps built side by side —
 * every test builds its own — must not share one.
 *
 * @param ports - See {@link SchedulingPorts}.
 * @returns The plugin that registers scheduling's ten route slices.
 */
export function createHttpPlugin(ports: SchedulingPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "scheduling", "list-scheduled-messages", listScheduledMessagesRoute);
    registerSlice(app, "scheduling", "get-scheduled-message", getScheduledMessageRoute);
    registerSlice(app, "scheduling", "create-scheduled-message", createScheduledMessageRoute(ports));
    registerSlice(app, "scheduling", "cancel-scheduled-message", cancelScheduledMessageRoute(ports));
    registerSlice(app, "scheduling", "suggest-schedule-date", suggestScheduleDateRoute);
    registerSlice(app, "scheduling", "create-return-reminder", createReturnReminderRoute(ports));
    registerSlice(app, "scheduling", "update-return-reminder", updateReturnReminderRoute(ports));
    registerSlice(app, "scheduling", "cancel-return-reminder", cancelReturnReminderRoute);
    registerSlice(app, "scheduling", "archive-vehicle-return", archiveVehicleReturnRoute);
    registerSlice(app, "scheduling", "unarchive-vehicle-return", unarchiveVehicleReturnRoute);
  };
}

/**
 * The due-tick port over a database handle: `run-due-tick`'s two steps and
 * `sync-scheduled`'s one.
 *
 * @param db - The database handle.
 * @returns The port the job drives; the worker's composition test wraps it to
 *   record the order.
 */
export function createScheduledDue(db: Db): ScheduledDue {
  return {
    recoverStaleProcessing: (now, staleMs) => recoverStaleProcessing(db, now, staleMs),
    dispatchDue: (now) => dispatchDue(db, now),
    syncOutboxOutcomes: () => syncOutboxOutcomes(db),
  };
}

/** What the scheduling job needs. */
export type SchedulingJobDeps = {
  db: Db;
  /** `WORKER_OUTBOX_POLL_MS`; the job's interval, the drain's own. */
  everyMs: number;
  /** Overrides the port built from `db`; the worker's composition test wraps the real one. */
  scheduled?: ScheduledDue;
};

/** The job's name, for the worker's failure-log map. */
export const DUE_AND_SYNC_JOB = "scheduling/due-and-sync";

/**
 * Registers ONE job that runs the due tick, then the outcome sync, in that
 * order (3B, ruling Q4). Both write `scheduled_message`; as two independent jobs
 * they could interleave on the same row.
 *
 * @param deps - See {@link SchedulingJobDeps}.
 * @returns What the worker's registry calls.
 */
export function createJobs(deps: SchedulingJobDeps): (register: RegisterJob) => void {
  const scheduled = deps.scheduled ?? createScheduledDue(deps.db);
  return (register) =>
    register({
      name: DUE_AND_SYNC_JOB,
      everyMs: deps.everyMs,
      run: async () => {
        await runDueTick(scheduled);
        await syncScheduled(scheduled);
      },
    });
}

export { CONNECTION_DISCONNECTED, DUE_TICK_CAP, PROCESSING_STALE_MS, runDueTick } from "./run-due-tick/index.js";
export { syncScheduled } from "./sync-scheduled/index.js";
export type { ScheduledDue } from "./internal/due-port.js";
export type { ChannelConnected, SchedulingPorts } from "./internal/ports.js";
