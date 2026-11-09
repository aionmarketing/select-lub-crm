/**
 * Cancels a queued outbound message before it is sent. With
 * {@link enqueueOutbound}, the only way anything outside `channel` writes
 * `outbox_message` (wave 3, ruling Q4).
 *
 * Its caller is the schedule-cancel path (`apps/api/src/scheduled`), which marks
 * the `scheduled_message` CANCELLED and this row `cancelled` in ONE transaction:
 * a schedule marked cancelled whose outbox row stayed `queued` would still be
 * sent by the drain. It keeps that atomicity by passing a handle over its own
 * transaction — `db.tx` joins it through the kernel's savepoint.
 *
 * Only a row that has not been claimed moves: `queued` or `blocked`. A row the
 * drain has already claimed, sent or confirmed is left alone, and the drain's own
 * result writes skip a `cancelled` row, so the two cannot overwrite each other.
 */
import type { Db } from "../../../kernel/db.js";

/**
 * Marks the unsent outbox row for `idempotencyKey` cancelled.
 *
 * @param db - The database handle; the write runs on `db.tx("channel", …)`.
 * @param idempotencyKey - The key the row was queued under.
 * @returns How many rows moved: 1, or 0 when none was still unsent.
 */
export async function cancelOutbound(db: Db, idempotencyKey: string): Promise<number> {
  return db.tx("channel", async (tx) => {
    const result = await tx.outboxMessage.updateMany({
      where: { idempotencyKey, status: { in: ["queued", "blocked"] } },
      data: { status: "cancelled" },
    });
    return result.count;
  });
}
