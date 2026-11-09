/**
 * Records ERP sync runs and integration errors: the only writer of
 * `sync_execution` and `integration_error`.
 *
 * Moved from `apps/worker/src/omie/prisma.ts` (`createPrismaSyncRunStore`) with
 * each method's body unchanged; what changed is that every operation now runs
 * in its own `db.tx("erp", …)`, so these writes happen under `module_erp`. One
 * transaction per operation, never one around the pull: the pull awaits the ERP
 * between these calls, and a transaction must not span a provider call (W2-C12).
 *
 * The two reads, `latestCompleted` (the incremental watermark) and
 * `hasRecordedError` (the duplicate-error guard), are part of the same port and
 * stay here. They are the only reads of these tables; nothing lists runs, so
 * there is no `list-sync-executions` slice (3A.3, recorded in tasks.md).
 */
import type { IntegrationErrorInput } from "../../../kernel/clients/erp-mock.js";
import type { SyncRunStore } from "./sync-run-store.js";
import type { Db } from "../../../kernel/db.js";

/**
 * Creates the sync-run recorder the pull and its importers write through.
 *
 * @param db - The database handle; each call opens its own `erp` transaction.
 * @returns A {@link SyncRunStore} over `sync_execution` and `integration_error`.
 */
export function createSyncRunRecorder(db: Db): SyncRunStore {
  return {
    startRun: (input) =>
      db.tx("erp", async (prisma) => {
        const row = await prisma.syncExecution.create({
          data: {
            source: input.source,
            entity: input.entity,
            mode: input.mode,
            windowFrom: input.windowFrom ? new Date(input.windowFrom) : null,
            status: "running",
            totals: { read: 0, written: 0, errors: 0 },
          },
        });
        return {
          id: row.id,
          source: row.source,
          entity: row.entity,
          mode: row.mode as "full" | "incremental",
          windowFrom: row.windowFrom?.toISOString() ?? null,
          windowTo: row.windowTo?.toISOString() ?? null,
          cursor: row.cursor,
          status: row.status as "running" | "completed" | "failed",
          totals: { read: 0, written: 0, errors: 0 },
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    updateRun: (id, patch) =>
      db.tx("erp", async (prisma) => {
        await prisma.syncExecution.update({
          where: { id },
          data: {
            cursor: patch.cursor,
            status: patch.status,
            windowTo: patch.windowTo ? new Date(patch.windowTo) : undefined,
            totals: patch.totals,
          },
        });
      }),
    latestCompleted: (entity) =>
      db.tx("erp", async (prisma) => {
        const row = await prisma.syncExecution.findFirst({
          where: { entity, status: "completed" },
          orderBy: { createdAt: "desc" },
        });
        if (!row) {
          return null;
        }
        const totals = (row.totals ?? { read: 0, written: 0, errors: 0 }) as {
          read: number;
          written: number;
          errors: number;
        };
        return {
          id: row.id,
          source: row.source,
          entity: row.entity,
          mode: row.mode as "full" | "incremental",
          windowFrom: row.windowFrom?.toISOString() ?? null,
          windowTo: row.windowTo?.toISOString() ?? null,
          cursor: row.cursor,
          status: "completed" as const,
          totals,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    record: (error: IntegrationErrorInput) =>
      db.tx("erp", async (prisma) => {
        await prisma.integrationError.create({
          data: {
            integration: "OMIE",
            operation: error.operation,
            correlationId: error.correlationId ?? null,
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            attemptCount: error.attemptCount,
          },
        });
      }),
    hasRecordedError: ({ code, correlationId }) =>
      db.tx("erp", async (prisma) => {
        // Scoped to OMIE because `record` above stamps that integration, so an
        // identically coded row from another integration is a different finding.
        const existing = await prisma.integrationError.findFirst({
          where: { integration: "OMIE", code, correlationId },
          select: { id: true },
        });
        return existing !== null;
      }),
  };
}
