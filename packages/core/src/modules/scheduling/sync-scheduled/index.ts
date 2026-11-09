/**
 * `sync-scheduled` — the worker job step that copies a sent message's outcome
 * from channel's outbox row back onto its schedule.
 *
 * Moved from `apps/worker/src/scheduled/prisma.ts` (`syncOutboxOutcomes`) and
 * `scheduled/due.ts` (`syncScheduled`). The second half of the ONE job
 * `scheduling/due-and-sync`, after `run-due-tick` (3B, ruling Q4). It reads
 * `outbox_message` (channel's table) under `readableBy` and writes only
 * `scheduled_message`.
 *
 * A confirmed outbox row makes the schedule `SENT`; a failed one makes it
 * `FAILED` with the outbox's reason. Both transitions are compare-and-set from
 * `PROCESSING` (the old adapter updated by id alone), so a row the api cancelled
 * meanwhile is not overwritten. One `db.tx` per row.
 *
 * A LATE DELIVERY IS RECORDED (`hold-unknown-followups`). The reclaim pass fails
 * an expired claim as `send_outcome_unknown`, and the sync then marks the schedule
 * `FAILED`. If the send it was waiting on later returns an id, the copy becomes
 * `confirmed`, and {@link settleLateDeliveries} moves the schedule on to `SENT`:
 * the customer got the message, so "Falhou" would be false. It does so even if the
 * attendant already resent the copy, since the resend is a separate message.
 */
import type { Db } from "../../../kernel/db.js";
import { OUTBOX_SEND_OUTCOME_UNKNOWN } from "../../channel/contracts/send-outcome.js";
import type { ScheduledDue } from "../internal/due-port.js";

/** Late deliveries settled per sync, the due tick's own cap. */
export const LATE_DELIVERY_CAP = 50;

/**
 * Marks each PROCESSING schedule SENT or FAILED from its outbox row's status;
 * leaves it PROCESSING while the outbox row is still in flight.
 *
 * @param db - The database handle.
 */
export async function syncOutboxOutcomes(db: Db): Promise<void> {
  const processing = await db.tx("scheduling", (tx) =>
    tx.scheduledMessage.findMany({ where: { status: "PROCESSING" }, select: { id: true, idempotencyKey: true } }),
  );
  for (const row of processing) {
    await db.tx("scheduling", async (tx) => {
      const outbox = await tx.outboxMessage.findUnique({
        where: { idempotencyKey: row.idempotencyKey },
        select: { status: true, lastError: true },
      });
      if (outbox?.status === "confirmed") {
        await tx.scheduledMessage.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: { status: "SENT", sentAt: new Date(), lastError: null },
        });
      } else if (outbox?.status === "failed") {
        await tx.scheduledMessage.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: { status: "FAILED", lastError: outbox.lastError },
        });
      }
    });
  }
  await settleLateDeliveries(db);
}

/**
 * Moves `FAILED` schedules whose outcome was unknown to `SENT` once their outbox
 * copy is `confirmed`. A refused schedule never moves: only the unknown reason is
 * read, and the write is compare-and-set on the status and the reason alike.
 *
 * @param db - The database handle.
 * @returns How many schedules moved.
 */
export async function settleLateDeliveries(db: Db): Promise<number> {
  const late = await db.tx("scheduling", (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM scheduled_message s
        JOIN outbox_message o ON o.idempotency_key = s.idempotency_key
       WHERE s.status = 'FAILED'
         AND s.last_error = ${OUTBOX_SEND_OUTCOME_UNKNOWN}
         AND o.status = 'confirmed'
       ORDER BY s.id
       LIMIT ${LATE_DELIVERY_CAP}
    `,
  );
  let moved = 0;
  for (const row of late) {
    moved += await db.tx("scheduling", async (tx) => {
      const written = await tx.scheduledMessage.updateMany({
        where: { id: row.id, status: "FAILED", lastError: OUTBOX_SEND_OUTCOME_UNKNOWN },
        data: { status: "SENT", sentAt: new Date(), lastError: null },
      });
      return written.count;
    });
  }
  return moved;
}

/**
 * Syncs PROCESSING schedules from their outbox outcomes.
 *
 * @param scheduled - The due-tick port; see the module's `createScheduledDue`.
 */
export async function syncScheduled(scheduled: ScheduledDue): Promise<void> {
  await scheduled.syncOutboxOutcomes();
}
