/**
 * Port for Omie pull-job progress and the integration errors a pull records.
 */
import type { IntegrationErrorSink } from "../../../kernel/clients/erp-mock.js";

/** One Omie pull execution row tracking mode, window, cursor, status, and totals. */
export type SyncExecutionRow = {
  id: string;
  source: string;
  entity: string;
  mode: "full" | "incremental";
  windowFrom: string | null;
  windowTo: string | null;
  cursor: string | null;
  status: "running" | "completed" | "failed";
  totals: { read: number; written: number; errors: number };
  createdAt: string;
  updatedAt: string;
};

/** Port for recording Omie pull runs and integration errors during sync jobs. */
export type SyncRunStore = IntegrationErrorSink & {
  /**
   * Starts a new sync run row in `running` status.
   *
   * @param input.source - Integration label (e.g. `"OMIE"`).
   * @param input.entity - Entity being synced (e.g. `"cliente"`).
   * @param input.mode - `"full"` or `"incremental"` pull mode.
   * @param input.windowFrom - ISO window start for incremental runs; `null` or omitted for full runs.
   * @returns New run row with zeroed totals and `status: "running"`.
   */
  startRun(input: {
    source: string;
    entity: string;
    mode: "full" | "incremental";
    windowFrom?: string | null;
  }): Promise<SyncExecutionRow>;
  /**
   * Patches cursor, status, window end, or totals on an existing run.
   *
   * @param id - Run uuid from `startRun`.
   * @param patch - Partial fields to merge; omitted keys are left unchanged.
   * @returns Resolves when the row is updated; no-op when `id` is unknown.
   */
  updateRun(
    id: string,
    patch: Partial<Pick<SyncExecutionRow, "cursor" | "status" | "windowTo" | "totals">>,
  ): Promise<void>;
  /**
   * Returns the most recently completed run for an entity.
   *
   * @param entity - Entity label (e.g. `"cliente"`).
   * @returns Latest `status: "completed"` row, or `null` when none exist.
   */
  latestCompleted(entity: string): Promise<SyncExecutionRow | null>;
  /**
   * Answers whether an error with this code and correlation id is already
   * recorded, so a caller can avoid surfacing the same finding twice.
   *
   * A narrow question on purpose. This replaced a pair of whole-table
   * inspectors (`runs()`, `errors()`) that the Prisma adapter answered `[]` to,
   * which silently disabled the duplicate guard built on them (GitHub #106).
   *
   * @param input.code - Error code to match, e.g. `omie_duplicate_candidate`.
   * @param input.correlationId - Correlation id the caller would record.
   * @returns True when such a row exists, resolved or not.
   */
  hasRecordedError(input: { code: string; correlationId: string }): Promise<boolean>;
};

