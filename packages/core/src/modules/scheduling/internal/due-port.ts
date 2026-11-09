/**
 * The due tick's three steps as one port, so the worker's composition test can
 * wrap the real implementation and record the order it is driven in.
 *
 * Moved from `apps/worker/src/scheduled/types.ts` (`ScheduledDue`), unchanged in
 * shape. The implementation is the module's `createScheduledDue(db)`, over
 * `run-due-tick` and `sync-scheduled`.
 */

/** Persistence port for due scheduled messages and outbox outcome sync. */
export type ScheduledDue = {
  /**
   * Resets PROCESSING schedules whose linked outbox row has been stale too long.
   *
   * @param now - Reference time for staleness comparison.
   * @param staleMs - Age in milliseconds after which a linked outbox row is considered stale.
   */
  recoverStaleProcessing(now: Date, staleMs: number): Promise<void>;
  /**
   * Claims due SCHEDULED rows and queues their outbox rows through channel.
   *
   * @param now - Reference time; schedules with `scheduledAt` at or before this instant are due.
   */
  dispatchDue(now: Date): Promise<void>;
  /** Marks PROCESSING schedules SENT or FAILED from their outbox row's outcome. */
  syncOutboxOutcomes(): Promise<void>;
};
