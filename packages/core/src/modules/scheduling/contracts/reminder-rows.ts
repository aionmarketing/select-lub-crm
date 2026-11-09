/**
 * The `scheduled_message` writes `services` makes when a vehicle return moves or
 * is superseded — the only way anything outside `scheduling` changes a reminder
 * row (3B for 3C, correction C4).
 *
 * They are exactly the three writes `packages/db/src/vehicle-return-date.ts`
 * and `vehicle-returns.ts` make today, which `module_services` will be refused
 * once 3C moves those files under it:
 * - `vehicle-return-date.ts`, per un-sent reminder row, inside the transaction
 *   that moves the return: {@link moveReminderRow} to its new instant and text,
 *   or {@link cancelReminderRow} when the new instant has already passed;
 * - `vehicle-returns.ts`, when a newer service supersedes a return:
 *   {@link cancelRemindersOfReturns}.
 *
 * And a fourth since the owner rulings of 2026-09-25, on `return_reminder_message`
 * rather than `scheduled_message`: {@link moveReminderMessages}, when the
 * reconcile collapses a duplicate return into the one it keeps.
 *
 * Each runs on `db.tx("scheduling", …)`, so the write is made under
 * scheduling's role whoever calls it. Called with a handle over the caller's
 * transaction (`createDb(tx)`), it joins that transaction through the kernel's
 * savepoint, and the caller's role is restored on exit, so a return and its
 * reminders still commit or fail together.
 *
 * COMPARE-AND-SET, AND WHAT A 0 MEANS (3B, ruling Q3). Every write carries
 * `status: "SCHEDULED"` in its `where`. The old code read the row as SCHEDULED
 * and then updated it by id; now that the due tick is its own job it can claim
 * the row in between, and a move or cancel by id would rewrite a message that is
 * already being sent. So each call returns how many rows it changed, and **a
 * caller must treat 0 as "already dispatched — leave it"**: the row is
 * `PROCESSING`, `SENT` or finished, and neither retrying nor failing is right.
 *
 * THE OUTBOX ROW GOES WITH IT (owner rulings, 2026-09-25). Both cancels go
 * through the module's `cancelUnlessPickedUp`: the row's `queued` or `blocked`
 * outbox row is cancelled in the same transaction (a `blocked` one used to stay
 * behind and show in the thread for ever), and a row whose outbox row the worker
 * has already picked up counts as dispatched — 0, leave it — even if the
 * stale-PROCESSING recovery put it back to `SCHEDULED`.
 */
import type { Db } from "../../../kernel/db.js";
import { cancelUnlessPickedUp, rewriteUnlessPickedUp } from "./unsent.js";

/**
 * Moves one un-sent reminder row to a new instant, with its text re-resolved
 * for that instant.
 *
 * @param db - The database handle; the write runs on `db.tx("scheduling", …)`.
 * @param input.scheduledMessageId - The row.
 * @param input.scheduledAt - The new send instant.
 * @param input.frozenText - The text resolved for that instant.
 * @param input.now - When "still in the future" is measured for holding a
 *   waiting copy; defaults to the clock. The return-date edit passes its own.
 * @returns 1 when the row moved; 0 when it had already left `SCHEDULED` (leave it).
 */
export async function moveReminderRow(
  db: Db,
  input: { scheduledMessageId: string; scheduledAt: Date; frozenText: string; now?: Date },
): Promise<number> {
  return db.tx("scheduling", async (tx) => {
    // Through rewriteUnlessPickedUp (owner rulings, 2026-09-25): a copy waiting
    // to be sent gets the new text, and is held until the new time.
    const outcome = await rewriteUnlessPickedUp(
      tx,
      input.scheduledMessageId,
      { scheduledAt: input.scheduledAt, frozenText: input.frozenText },
      input.now,
    );
    return outcome === "rewritten" ? 1 : 0;
  });
}

/**
 * Cancels one un-sent reminder row, recording why.
 *
 * @param db - The database handle; the write runs on `db.tx("scheduling", …)`.
 * @param input.scheduledMessageId - The row.
 * @param input.at - The cancel instant.
 * @param input.reason - Stored in `last_error`, shown to the attendant.
 * @returns 1 when the row was cancelled; 0 when it had already left `SCHEDULED` (leave it).
 */
export async function cancelReminderRow(
  db: Db,
  input: { scheduledMessageId: string; at: Date; reason: string },
): Promise<number> {
  return db.tx("scheduling", async (tx) => {
    const outcome = await cancelUnlessPickedUp(tx, input.scheduledMessageId, {
      from: "scheduled",
      at: input.at,
      lastError: input.reason,
    });
    return outcome === "cancelled" ? 1 : 0;
  });
}

/**
 * Cancels every un-sent reminder row of the given returns, recording why.
 *
 * A row that has gone out cannot be recalled, and one mid-dispatch is the due
 * tick's; only `SCHEDULED` rows move.
 *
 * @param db - The database handle; the write runs on `db.tx("scheduling", …)`.
 * @param input.vehicleReturnIds - The superseded returns. Empty cancels nothing.
 * @param input.at - The cancel instant.
 * @param input.reason - Stored in `last_error`.
 * @returns How many rows were cancelled. Rows already dispatched are not
 *   counted, and a caller must leave them be.
 */
export async function cancelRemindersOfReturns(
  db: Db,
  input: { vehicleReturnIds: readonly string[]; at: Date; reason: string },
): Promise<{ cancelled: number }> {
  if (input.vehicleReturnIds.length === 0) {
    return { cancelled: 0 };
  }
  return db.tx("scheduling", async (tx) => {
    const rows = await tx.scheduledMessage.findMany({
      where: {
        status: "SCHEDULED",
        returnReminderMessage: { vehicleReturnId: { in: [...input.vehicleReturnIds] } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    let cancelled = 0;
    for (const row of rows) {
      const outcome = await cancelUnlessPickedUp(tx, row.id, {
        from: "scheduled",
        at: input.at,
        lastError: input.reason,
      });
      if (outcome === "cancelled") cancelled += 1;
    }
    return { cancelled };
  });
}

/**
 * Moves the reminder messages of duplicate returns onto the return that is
 * kept (owner rulings, 2026-09-25).
 *
 * Two reconciles racing could each open a return for the same service, so the
 * vehicle held the same return twice. The reconcile now keeps the oldest; the
 * messages an attendant hung on a duplicate move to it rather than being stopped
 * with the duplicate. Their scheduled rows are untouched: each keeps its send
 * instant, text and outbox key, because only the message's return changes.
 *
 * @param db - The database handle; the write runs on `db.tx("scheduling", …)`.
 * @param input.fromReturnIds - The duplicates, about to be superseded. Empty moves nothing.
 * @param input.toReturnId - The return that is kept.
 * @returns How many reminder messages moved.
 */
export async function moveReminderMessages(
  db: Db,
  input: { fromReturnIds: readonly string[]; toReturnId: string },
): Promise<number> {
  if (input.fromReturnIds.length === 0) {
    return 0;
  }
  return db.tx("scheduling", async (tx) => {
    const result = await tx.returnReminderMessage.updateMany({
      where: { vehicleReturnId: { in: [...input.fromReturnIds] } },
      data: { vehicleReturnId: input.toReturnId },
    });
    return result.count;
  });
}
