/**
 * Rewrites the copy of a scheduled message that is waiting to be sent, when the
 * attendant edits the reminder it belongs to (owner rulings, 2026-09-25). With
 * {@link cancelOutbound}, the only way anything outside `channel` touches an
 * `outbox_message` it did not create.
 *
 * A reminder's copy waits `blocked` after a disconnected due attempt, or
 * `queued` after a send that hung past both the stale-PROCESSING reset and the
 * claim timeout. Editing the reminder used to change only the schedule, so the
 * copy went out with the OLD text — and, for a `queued` copy moved later, at the
 * OLD time. Its caller is scheduling's `rewriteUnlessPickedUp`, in the edit's
 * own transaction.
 *
 * Only an unsent copy moves: `queued` or `blocked`. A copy the drain has
 * claimed, sent or confirmed is left alone; the caller then leaves the schedule
 * alone too, so the screen matches what the customer gets.
 */
import type { Db } from "../../../kernel/db.js";

/** The reason a `queued` copy is held `blocked` until its new time. */
export const OUTBOX_BLOCKED_RESCHEDULED = "rescheduled";

/**
 * Writes the new text on the unsent copy for `idempotencyKey`, and holds a
 * `queued` copy `blocked` when the message now goes out later.
 *
 * Holding it is what keeps the drain from sending it now, at the old time: the
 * drain claims only `queued` rows. At the new time the due tick claims the
 * schedule, and `enqueueOutbound`'s reconcile unblocks the copy, writing the
 * schedule's current text again as it does.
 *
 * @param db - The database handle; the write runs on `db.tx("channel", …)`.
 * @param input.idempotencyKey - The schedule's outbox key.
 * @param input.textBody - The edited text.
 * @param input.holdUntilDue - True when the new send time is still in the future.
 * @returns How many copies were rewritten: 1, or 0 when none was still unsent.
 */
export async function rewriteUnsentOutbound(
  db: Db,
  input: { idempotencyKey: string; textBody: string; holdUntilDue: boolean },
): Promise<number> {
  return db.tx("channel", async (tx) => {
    const rewritten = await tx.outboxMessage.updateMany({
      where: { idempotencyKey: input.idempotencyKey, status: { in: ["queued", "blocked"] } },
      data: { textBody: input.textBody },
    });
    if (input.holdUntilDue) {
      await tx.outboxMessage.updateMany({
        where: { idempotencyKey: input.idempotencyKey, status: "queued" },
        data: { status: "blocked", lastError: OUTBOX_BLOCKED_RESCHEDULED },
      });
    }
    return rewritten.count;
  });
}
