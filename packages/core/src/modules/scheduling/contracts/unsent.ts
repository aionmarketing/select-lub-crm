/**
 * Cancelling or rewriting one schedule together with its outbox copy, unless
 * the worker has already picked the message up (owner rulings, 2026-09-25).
 *
 * `cancelUnlessPickedUp` cancels; `rewriteUnlessPickedUp` (below) carries an
 * edit — new text, new time — to the copy waiting to be sent. Both read "picked
 * up" from the outbox copy the same way, and both lock the schedule row first.
 *
 * In `contracts/` rather than `internal/` because `reminder-rows.ts`, a contract,
 * calls it, and a contract may not reach `internal/`. It is deliberately left out
 * of `contracts/index.ts`: no other module needs it.
 *
 * Every path that cancels a schedule goes through {@link cancelUnlessPickedUp}:
 * the attendant's cancel route, cancelling a reminder message, a reminder moment
 * dropped by an edit, a reminder pushed into the past, and a superseded return's
 * reminders. Before this, only the route cancelled the outbox row, so a reminder
 * due while the channel was down kept a `blocked` outbox row behind a `CANCELLED`
 * schedule, and the thread showed that bubble as blocked for ever.
 *
 * "PICKED UP" IS READ FROM THE OUTBOX ROW, not from the schedule's status: a row
 * `claimed`, `sent` or `confirmed` is on its way or has arrived. A schedule the
 * stale-PROCESSING recovery put back to `SCHEDULED` can still have one. Marking
 * such a schedule `CANCELLED` would tell the attendant a message was stopped
 * when the customer receives it, so it is left exactly as it is.
 *
 * THE ORDER, AND WHY NOTHING IS EVER UNDONE.
 * 1. Lock the schedule row (`FOR UPDATE`). A due tick claiming the same schedule
 *    waits for this transaction, or has committed its outbox row before the lock
 *    was granted, so step 2 sees it.
 * 2. `cancelOutbound`. A `queued` or `blocked` row becomes `cancelled`, and the
 *    drain's claim, which re-checks `status = 'queued'` under
 *    `FOR UPDATE SKIP LOCKED` (`channel/drain-outbox/queries.ts`, since #165),
 *    can no longer take it.
 * 3. Nothing moved and the row is picked up: write nothing. Otherwise (no row,
 *    or one `failed` or already `cancelled`) mark the schedule.
 */
import { createDb, type DbClient } from "../../../kernel/db.js";
import { cancelOutbound } from "../../channel/contracts/cancel-outbound.js";
import { rewriteUnsentOutbound } from "../../channel/contracts/rewrite-outbound.js";

/** Outbox statuses meaning the worker has picked the message up. */
export const PICKED_UP_OUTBOX_STATUSES: readonly string[] = ["claimed", "sent", "confirmed"];

/** Which schedule statuses a caller may cancel from. */
export type CancelFrom = "scheduled" | "not-sent";

/** What happened to one schedule. */
export type CancelOutcome = "cancelled" | "picked_up" | "unchanged";

/**
 * Cancels one schedule and its unsent outbox row in the caller's transaction,
 * unless the worker has picked the message up.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param scheduleId - The schedule.
 * @param input.from - `"scheduled"` for the reminder paths (only a `SCHEDULED`
 *   row moves); `"not-sent"` for the attendant's route, which has always
 *   cancelled any row not yet `SENT`.
 * @param input.at - The cancel instant.
 * @param input.lastError - Written to `last_error`: a reason string, or `null`
 *   to clear it. Omitted, the column is left as it was, which is what the
 *   reminder-message cancel and the edit have always done.
 * @returns `"cancelled"`; `"picked_up"` when the outbox row is `claimed`,
 *   `sent` or `confirmed` and nothing was written; `"unchanged"` when the
 *   schedule is missing or not in a status `from` allows.
 */
export async function cancelUnlessPickedUp(
  tx: DbClient,
  scheduleId: string,
  input: { from: CancelFrom; at: Date; lastError?: string | null },
): Promise<CancelOutcome> {
  const locked = await tx.$queryRaw<{ status: string; idempotency_key: string }[]>`
    SELECT status, idempotency_key FROM scheduled_message WHERE id = ${scheduleId} FOR UPDATE
  `;
  const row = locked[0];
  if (!row || !allowed(row.status, input.from)) {
    return "unchanged";
  }
  const moved = await cancelOutbound(createDb(tx), row.idempotency_key);
  if (moved === 0) {
    const outbox = await tx.outboxMessage.findUnique({
      where: { idempotencyKey: row.idempotency_key },
      select: { status: true },
    });
    if (outbox && PICKED_UP_OUTBOX_STATUSES.includes(outbox.status)) {
      return "picked_up";
    }
  }
  await tx.scheduledMessage.update({
    where: { id: scheduleId },
    data: {
      status: "CANCELLED",
      cancelledAt: input.at,
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    },
  });
  return "cancelled";
}

function allowed(status: string, from: CancelFrom): boolean {
  return from === "scheduled" ? status === "SCHEDULED" : status !== "SENT";
}

/** The columns an edit changes on one reminder row. */
export type ReminderRowChange = { frozenText?: string; scheduledAt?: Date; leadDays?: number | null };

/** What happened to one reminder row under an edit. */
export type RewriteOutcome = "rewritten" | "picked_up" | "unchanged";

/**
 * Applies an edit to one `SCHEDULED` reminder row AND to its copy waiting to be
 * sent, unless the worker has picked the message up.
 *
 * A reminder's copy waits `blocked` after a disconnected due attempt, or
 * `queued` after a send that hung past both the stale-PROCESSING reset and the
 * claim timeout. Editing the schedule alone left that copy with the OLD text
 * (the due tick's reconcile unblocked it as it was), and a `queued` copy moved
 * later went out at the OLD time: the drain claims `queued` rows whenever it
 * runs.
 *
 * In order:
 * 1. Lock the schedule row; only a `SCHEDULED` one moves.
 * 2. `rewriteUnsentOutbound`: an unsent copy gets the edited text, and while the
 *    row's send time (edited or not) is still in the future a `queued` copy is
 *    held `blocked` — the due tick unblocks it at that time.
 * 3. Nothing moved and the copy is `claimed`, `sent` or `confirmed`: write
 *    nothing, it is going out as it was. Otherwise (no copy, or one `failed` or
 *    `cancelled`) update the schedule.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param scheduleId - The reminder row.
 * @param change - The columns the edit sets.
 * @param now - When "still in the future" is measured; defaults to the clock.
 * @returns `"rewritten"`; `"picked_up"` when the copy is on its way and nothing
 *   was written; `"unchanged"` when the row is missing or not `SCHEDULED`.
 */
export async function rewriteUnlessPickedUp(
  tx: DbClient,
  scheduleId: string,
  change: ReminderRowChange,
  now: Date = new Date(),
): Promise<RewriteOutcome> {
  const locked = await tx.$queryRaw<
    { status: string; idempotency_key: string; frozen_text: string; scheduled_at: Date }[]
  >`
    SELECT status, idempotency_key, frozen_text, scheduled_at
      FROM scheduled_message WHERE id = ${scheduleId} FOR UPDATE
  `;
  const row = locked[0];
  if (!row || row.status !== "SCHEDULED") {
    return "unchanged";
  }
  const sendAt = change.scheduledAt ?? row.scheduled_at;
  const moved = await rewriteUnsentOutbound(createDb(tx), {
    idempotencyKey: row.idempotency_key,
    textBody: change.frozenText ?? row.frozen_text,
    holdUntilDue: sendAt.getTime() > now.getTime(),
  });
  if (moved === 0) {
    const outbox = await tx.outboxMessage.findUnique({
      where: { idempotencyKey: row.idempotency_key },
      select: { status: true },
    });
    if (outbox && PICKED_UP_OUTBOX_STATUSES.includes(outbox.status)) {
      return "picked_up";
    }
  }
  // Still compare-and-set on SCHEDULED, as the edit's writes always were: the
  // lock above keeps a due tick from claiming the row now, and this keeps that
  // true even for a write inside the same transaction.
  const written = await tx.scheduledMessage.updateMany({
    where: { id: scheduleId, status: "SCHEDULED" },
    data: change,
  });
  return written.count === 1 ? "rewritten" : "unchanged";
}
