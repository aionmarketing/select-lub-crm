/**
 * Cancelling a reminder message and its un-sent moments. Moved from
 * `packages/db/src/return-reminders.ts` (`cancelReturnReminderMessage`).
 *
 * It used to open its own transaction; it now runs on its caller's
 * `db.tx("scheduling", …)`, so marking the message and its rows is still one
 * commit.
 */
import type { DbClient } from "../../../kernel/db.js";
import { cancelUnlessPickedUp } from "../contracts/unsent.js";

/**
 * Cancels a reminder message and every one of its un-sent scheduled messages.
 *
 * SENT has left and cannot be recalled; FAILED is finished; PROCESSING is
 * mid-dispatch and cancelling it would race the due tick for a row it has
 * already claimed. SCHEDULED is the only state that can still be stopped, and
 * the `where` carries it, so the update is a compare-and-set.
 *
 * Each row goes through `cancelUnlessPickedUp` (owner rulings, 2026-09-25), so
 * its outbox row is cancelled with it. A `SCHEDULED` row usually has none — the
 * due tick queues one when it claims the row — but a row the due tick found on a
 * disconnected channel went back to `SCHEDULED` beside a `blocked` outbox row,
 * which used to stay `blocked`, and show in the thread as blocked, for ever. A
 * row whose outbox row the worker has already picked up is left as it is and not
 * counted: it is going out.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param reminderMessageId - The message to cancel.
 * @returns How many scheduled rows were cancelled.
 * @throws When the reminder message does not exist.
 */
export async function cancelReminder(
  tx: DbClient,
  reminderMessageId: string,
): Promise<{ cancelled: number }> {
  const row = await tx.returnReminderMessage.findUnique({
    where: { id: reminderMessageId },
    select: { id: true },
  });
  if (!row) {
    throw new Error(`return reminder message ${reminderMessageId} not found`);
  }

  const now = new Date();
  await tx.returnReminderMessage.update({
    where: { id: reminderMessageId },
    data: { cancelledAt: now },
  });
  const rows = await tx.scheduledMessage.findMany({
    where: { returnReminderMessageId: reminderMessageId, status: "SCHEDULED" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let cancelled = 0;
  for (const scheduled of rows) {
    const outcome = await cancelUnlessPickedUp(tx, scheduled.id, { from: "scheduled", at: now });
    if (outcome === "cancelled") cancelled += 1;
  }
  return { cancelled };
}
