/**
 * `run-due-tick` — the worker job step that hands due scheduled messages to
 * channel's outbox.
 *
 * Moved from `apps/worker/src/scheduled/prisma.ts` (`recoverStaleProcessing`,
 * `dispatchDue`) and `scheduled/due.ts` (`runDueTick`). Registered as the first
 * half of ONE job, `scheduling/due-and-sync`, with `sync-scheduled` after it
 * (3B, ruling Q4): both steps write `scheduled_message`, so they run one after
 * the other, never side by side.
 *
 * The outbox is never written here. A due row is queued through channel's
 * `enqueueOutbound`, passing `connected` from the STORED `connection_state`
 * column (the due tick's source; the api uses the live probe) and
 * `onExisting: "reconcile"`, whose re-block and unblock are compare-and-set, so
 * a row the drain has claimed, sent or confirmed is never touched (3A, Q1-A).
 *
 * EVERY `scheduled_message` TRANSITION HERE IS COMPARE-AND-SET. The old adapter
 * claimed with a status guard but reset by id alone. The resets now carry
 * `status: "PROCESSING"` too, so a row cancelled by the api between the read and
 * the write stays cancelled instead of being revived as `SCHEDULED`.
 *
 * One `db.tx` per row: its claim, its enqueue (channel's `db.tx`, joined through
 * the savepoint) and a disconnected reset commit together. Nothing here calls a
 * provider.
 */
import type { Db } from "../../../kernel/db.js";
import { createDb } from "../../../kernel/db.js";
import { enqueueOutbound, OUTBOX_BLOCKED_DISCONNECTED } from "../../channel/contracts/enqueue-outbound.js";
import type { ScheduledDue } from "../internal/due-port.js";

/** Stale threshold before a PROCESSING schedule row is reset to SCHEDULED. */
export const PROCESSING_STALE_MS = 5 * 60 * 1000;

/** Maximum schedule rows dispatched per tick. */
export const DUE_TICK_CAP = 50;

/**
 * Last-error token written when the WhatsApp connection is not CONNECTED.
 *
 * Channel's own constant, so the value on `scheduled_message` and on the blocked
 * `outbox_message` cannot drift apart.
 */
export const CONNECTION_DISCONNECTED = OUTBOX_BLOCKED_DISCONNECTED;

/**
 * Puts PROCESSING rows back to SCHEDULED when their outbox row is missing, or
 * has sat unfinished (not confirmed, failed or claimed) longer than `staleMs`.
 * A confirmed or failed outbox row is left for the sync.
 *
 * A `claimed` row is never a reason to reset (`hold-unknown-outcome-sends`). A
 * long claim means a drain stopped mid-send, so the message may have gone out:
 * channel's reclaim pass fails that row as an unknown outcome, and the sync then
 * marks the schedule FAILED. The reclaim runs every 180 s against a 180 s cutoff,
 * so it can settle a claim after this 5-minute threshold; hence the explicit
 * skip, rather than trusting the order of the two timers. Before, the reset let
 * the next due tick leave the claimed copy alone, and once the reclaim requeued
 * it the customer got the message twice.
 *
 * @param db - The database handle; each row's reset is its own `db.tx("scheduling", …)`.
 * @param now - Reference time for staleness.
 * @param staleMs - Age after which an unfinished outbox row is stale.
 */
export async function recoverStaleProcessing(db: Db, now: Date, staleMs: number): Promise<void> {
  const processing = await db.tx("scheduling", (tx) =>
    tx.scheduledMessage.findMany({ where: { status: "PROCESSING" }, select: { id: true, idempotencyKey: true } }),
  );
  for (const row of processing) {
    await db.tx("scheduling", async (tx) => {
      const outbox = await tx.outboxMessage.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
      const stale =
        !outbox ||
        (outbox.status !== "confirmed" &&
          outbox.status !== "failed" &&
          outbox.status !== "claimed" &&
          outbox.updatedAt.getTime() <= now.getTime() - staleMs);
      if (stale) {
        await tx.scheduledMessage.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: { status: "SCHEDULED" },
        });
      }
    });
  }
}

/**
 * Claims up to {@link DUE_TICK_CAP} due SCHEDULED rows with a conversation and
 * queues each through channel. On a channel the stored column says is down, the
 * outbox row is `blocked` and the schedule goes back to SCHEDULED with
 * {@link CONNECTION_DISCONNECTED}, to be tried again on a later tick.
 *
 * The claim re-checks that the row is still due, and the queued text is read
 * from the claimed row, not from the list, so an edit that commits between the
 * two is honoured (review of #170).
 *
 * @param db - The database handle.
 * @param now - Rows with `scheduledAt` at or before this instant are due.
 */
export async function dispatchDue(db: Db, now: Date): Promise<void> {
  const due = await db.tx("scheduling", (tx) =>
    tx.scheduledMessage.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now }, conversationId: { not: null } },
      orderBy: { scheduledAt: "asc" },
      take: DUE_TICK_CAP,
      select: { id: true, conversationId: true, idempotencyKey: true },
    }),
  );
  for (const row of due) {
    const conversationId = row.conversationId;
    if (!conversationId) {
      continue;
    }
    await db.tx("scheduling", async (tx) => {
      // The claim re-checks that the row is still due, and the text is read
      // from the row it claimed, not from the list above (review of #170). An
      // edit committing between that read and this claim — moving the row
      // later and holding its copy — used to be claimed anyway, and the
      // reconcile then wrote the OLD text over the edited copy and sent it at
      // the old time. The claim's row lock keeps the text fixed from here on.
      const claimed = await tx.scheduledMessage.updateMany({
        where: { id: row.id, status: "SCHEDULED", scheduledAt: { lte: now } },
        data: { status: "PROCESSING", lastError: null },
      });
      if (claimed.count === 0) {
        return;
      }
      const { frozenText } = await tx.scheduledMessage.findUniqueOrThrow({
        where: { id: row.id },
        select: { frozenText: true },
      });
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { whatsappConnection: { select: { connectionState: true } } },
      });
      const connected = conversation?.whatsappConnection.connectionState === "CONNECTED";
      await enqueueOutbound(createDb(tx), {
        conversationId,
        textBody: frozenText,
        idempotencyKey: row.idempotencyKey,
        connected,
        onExisting: "reconcile",
      });
      if (!connected) {
        await tx.scheduledMessage.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: { status: "SCHEDULED", lastError: CONNECTION_DISCONNECTED },
        });
      }
    });
  }
}

/**
 * Recovers stale PROCESSING rows, then dispatches due SCHEDULED ones.
 *
 * @param scheduled - The due-tick port; see the module's `createScheduledDue`.
 * @param now - Reference time; defaults to the current instant.
 */
export async function runDueTick(scheduled: ScheduledDue, now = new Date()): Promise<void> {
  await scheduled.recoverStaleProcessing(now, PROCESSING_STALE_MS);
  await scheduled.dispatchDue(now);
}
