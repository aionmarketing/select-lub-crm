/**
 * The attendant's resend of a message that did not go out
 * (`hold-unknown-outcome-sends`, design D6). Conversations' `resend-message`
 * slice calls it after the loja check and the live probe; the write is channel's,
 * like every other `outbox_message` write outside the drain.
 *
 * In one transaction, holding the original row's lock:
 * 1. an earlier resend of this row (key `resend:<id>`) is returned as it is, so a
 *    second press never queues a second copy, even after a first press cancelled a
 *    `blocked` original;
 * 2. the guard is re-checked on the locked row: text, and `failed`, or `blocked`
 *    when the caller says the attendant sent it;
 * 3. a `blocked` original is cancelled, so nothing can release it later;
 * 4. a new row is queued with the original's text, copied here, never taken from
 *    the request.
 */
import { createDb, type Db } from "../../../kernel/db.js";
import { enqueueOutbound, type EnqueuedOutbound } from "./enqueue-outbound.js";

/** The idempotency key a resend of `outboxId` is queued under. */
export function resendKeyOf(outboxId: string): string {
  return `resend:${outboxId}`;
}

/** What a resend did. */
export type ResendOutcome =
  | { status: "not_found" }
  | { status: "not_allowed" }
  | { status: "queued"; row: EnqueuedOutbound };

type LockedRow = { conversation_id: string; status: string; message_type: string; text_body: string | null };

/**
 * Queues a copy of an outbox row that did not go out.
 *
 * @param db - The database handle; everything runs on one `db.tx("channel", …)`.
 * @param input.outboxId - The row to send again.
 * @param input.conversationId - The conversation the caller checked; a row of
 *   another conversation is `not_found`.
 * @param input.allowBlocked - Whether a `blocked` row may be resent: true only when
 *   the attendant sent it. A scheduled message's blocked copy stays with the due
 *   tick.
 * @returns `queued` with the new row (or the one an earlier press queued),
 *   `not_found`, or `not_allowed`.
 */
export async function resendUnsentOutbound(
  db: Db,
  input: { outboxId: string; conversationId: string; allowBlocked: boolean },
): Promise<ResendOutcome> {
  return db.tx("channel", async (tx) => {
    const locked = await tx.$queryRaw<LockedRow[]>`
      SELECT conversation_id, status, message_type, text_body
        FROM outbox_message WHERE id = ${input.outboxId} FOR UPDATE
    `;
    const row = locked[0];
    if (!row || row.conversation_id !== input.conversationId) {
      return { status: "not_found" };
    }
    const key = resendKeyOf(input.outboxId);
    const earlier = await tx.outboxMessage.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
    const resendable =
      row.message_type === "text" &&
      Boolean(row.text_body?.trim()) &&
      (row.status === "failed" || (input.allowBlocked && row.status === "blocked"));
    if (!earlier && !resendable) {
      return { status: "not_allowed" };
    }
    if (!earlier && row.status === "blocked") {
      await tx.outboxMessage.updateMany({
        where: { id: input.outboxId, status: "blocked" },
        data: { status: "cancelled" },
      });
    }
    const queued = await enqueueOutbound(createDb(tx), {
      conversationId: input.conversationId,
      messageType: "text",
      textBody: row.text_body,
      idempotencyKey: key,
      connected: true,
      onExisting: "keep",
    });
    return { status: "queued", row: queued };
  });
}
