/**
 * The drain's reads and writes on `outbox_message`, each in its own
 * `db.tx("channel", …)`.
 *
 * Moved from `apps/worker/src/outbox/prisma.ts` with the SQL byte-for-byte, except
 * the claim, rewritten on 2026-09-25 to lock what it picks. What else changed is
 * only where each statement runs: under channel's role, and one
 * transaction per operation, never one around the send (W2-C12). The claim and
 * its conversation read share a transaction because both are needed to route the
 * send and neither waits on anything outside the database.
 *
 * THE CLOCK IS THE DATABASE'S. The backoff and the claim compare against `NOW()`,
 * not JavaScript's, and inside a transaction `NOW()` is `transaction_timestamp()`,
 * which does not advance. Tests that age a row do it in SQL.
 */
import type { Db } from "../../../kernel/db.js";
import { OUTBOX_RETRY_BACKOFF_MS, OUTBOX_RETRY_MAX_ATTEMPTS } from "../internal/ports.js";

/** Outbox row claimed for send, with the conversation's routing fields. */
export type ClaimedOutbox = {
  id: string;
  conversationId: string;
  messageType: string;
  textBody: string | null;
  mediaBytes: Uint8Array | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  remoteJid: string;
  customerPhoneNormalized: string;
  whatsappConnectionId: string;
  instanceName: string;
};

type ClaimRow = {
  id: string;
  conversation_id: string;
  message_type: string;
  text_body: string | null;
  media_bytes: Uint8Array | null;
  media_mime_type: string | null;
  media_file_name: string | null;
};

/**
 * Atomically claims the oldest claimable `queued` row and reads its routing.
 *
 * @param db - The database handle.
 * @returns The claimed row, or `null` when nothing is claimable.
 */
export async function claimQueued(db: Db): Promise<ClaimedOutbox | null> {
  return db.tx("channel", async (prisma) => {
    // A MATERIALIZED CTE with FOR UPDATE SKIP LOCKED, and `status = 'queued'`
    // checked again on the row the UPDATE writes (owner rulings, 2026-09-25).
    //
    // It used to be `WHERE id = (SELECT … LIMIT 1)` with no lock: two drains
    // could both pick the same id, the second UPDATE waited for the first to
    // commit, then re-checked only `id = …` (the status filter sat inside the
    // subquery, which is not re-run) and claimed the row again, so the customer
    // got the message twice. SKIP LOCKED sends the second drain to the next
    // row instead, and the outer status check stops a row that moved on from
    // being written.
    //
    // Not `WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` either: rescanned on
    // the inner side of a nested loop, that subquery skips the rows its own
    // statement already updated and reaches further, so it claims more than one.
    // The same trap erp's drain hit; the forced-plan case in
    // packages/core/test/outbox-claim-race.live.test.ts pins it.
    const rows = await prisma.$queryRaw<ClaimRow[]>`
      WITH picked AS MATERIALIZED (
        SELECT id FROM outbox_message
        WHERE status = 'queued'
          -- Backoff. A row that has already failed is not claimable again until
          -- the interval has passed, which is what lets the drain loop continue
          -- past a retryable failure instead of ending the tick: an oldest-first
          -- claim would otherwise re-select it immediately and spend its whole
          -- attempt budget inside one tick.
          --
          -- Keyed on updated_at because markFailedQueued already sets it at
          -- exactly the right moment, so no column and no migration is needed.
          -- The attempt_count = 0 guard is what keeps that from over-reaching:
          -- a row that has never failed is claimable whatever its updated_at, so
          -- an ordinary write to a fresh row cannot postpone it.
          AND (
            attempt_count = 0
            OR updated_at < NOW() - (${OUTBOX_RETRY_BACKOFF_MS} * INTERVAL '1 millisecond')
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_message AS o
      SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
      FROM picked
      WHERE o.id = picked.id AND o.status = 'queued'
      RETURNING o.id, o.conversation_id, o.message_type, o.text_body, o.media_bytes, o.media_mime_type, o.media_file_name
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    // `conversation` is conversations' table; channel reads it under
    // `readableBy: "*"` and never writes it.
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: row.conversation_id },
      include: { whatsappConnection: true },
    });
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageType: row.message_type,
      textBody: row.text_body,
      mediaBytes: row.media_bytes,
      mediaMimeType: row.media_mime_type,
      mediaFileName: row.media_file_name,
      remoteJid: conversation.remoteJid,
      customerPhoneNormalized: conversation.chatKey,
      whatsappConnectionId: conversation.whatsappConnectionId,
      instanceName: conversation.whatsappConnection.instanceName,
    };
  });
}

/**
 * Marks a send confirmed with the provider message id and clears media bytes.
 * A no-op on a `cancelled` row.
 *
 * Deliberately NOT compare-and-set on `claimed`: when the reclaim pass has
 * already failed the row as an unknown outcome and the send then returns an id,
 * the message did go out, and the row says so (`hold-unknown-outcome-sends`, D3).
 *
 * @param db - The database handle.
 * @param id - Outbox row id.
 * @param externalMessageId - Provider message id returned by Evolution.
 */
export async function markConfirmed(db: Db, id: string, externalMessageId: string): Promise<void> {
  await db.tx("channel", (prisma) =>
    prisma.outboxMessage.updateMany({
      where: { id, status: { not: "cancelled" } },
      data: { status: "confirmed", externalMessageId, mediaBytes: null },
    }),
  );
}

/**
 * Blocks a send when the instance does not exist (Evolution `404`). A no-op on a
 * row no longer `claimed`: a cancelled row stays cancelled, and one the reclaim
 * pass already failed is not revived.
 *
 * @param db - The database handle.
 * @param id - Outbox row id.
 * @param lastError - Sanitized error token (the drain caps it at 120 chars).
 */
export async function markBlocked(db: Db, id: string, lastError: string): Promise<void> {
  await db.tx("channel", (prisma) =>
    prisma.outboxMessage.updateMany({
      where: { id, status: "claimed" },
      data: { status: "blocked", lastError, mediaBytes: null },
    }),
  );
}

/**
 * Fails a send at once, without a retry: the provider refused it, or its outcome
 * is unknown (`hold-unknown-outcome-sends`). The attempt is counted, the claim
 * cleared and media bytes discarded. A no-op on a row no longer `claimed`.
 *
 * @param db - The database handle.
 * @param id - Outbox row id.
 * @param lastError - The reason: a refusal token, or `send_outcome_unknown`.
 */
export async function markFailedNow(db: Db, id: string, lastError: string): Promise<void> {
  await db.tx("channel", (prisma) =>
    prisma.$executeRaw`
      UPDATE outbox_message
      SET status = 'failed', last_error = ${lastError}, attempt_count = attempt_count + 1,
          claimed_at = NULL, media_bytes = NULL, updated_at = NOW()
      WHERE id = ${id} AND status = 'claimed'
    `,
  );
}

/**
 * Records a retryable send failure, then requeues the row or fails it for good
 * once the attempt bound is reached.
 *
 * @param db - The database handle.
 * @param id - Outbox row id.
 * @param lastError - Sanitized error token stored on the row.
 * @returns The attempt count and status after the failure, or `null` when the
 *   row is no longer `claimed` (cancelled, missing, or already failed by the
 *   reclaim pass).
 */
export async function markFailedQueued(
  db: Db,
  id: string,
  lastError: string,
): Promise<{ attemptCount: number; status: string } | null> {
  return db.tx("channel", async (prisma) => {
    const rows = await prisma.$queryRaw<{ attempt_count: number; status: string }[]>`
      UPDATE outbox_message
      SET
        attempt_count = attempt_count + 1,
        last_error = ${lastError},
        -- The attempt bound applies to every message type. It used to be guarded
        -- on media_bytes, so a text row returned to 'queued' however often it
        -- failed; with the claim taking the oldest queued row, one undeliverable
        -- message was re-attempted every tick forever and nothing else was sent.
        status = CASE
          WHEN attempt_count + 1 >= ${OUTBOX_RETRY_MAX_ATTEMPTS} THEN 'failed'
          ELSE 'queued'
        END,
        -- Clearing the bytes stays media-specific: this was one condition with
        -- the status above only because media was the only type that terminated.
        media_bytes = CASE
          WHEN media_bytes IS NOT NULL AND attempt_count + 1 >= ${OUTBOX_RETRY_MAX_ATTEMPTS} THEN NULL
          ELSE media_bytes
        END,
        updated_at = NOW()
      WHERE id = ${id} AND status = 'claimed'
      RETURNING attempt_count, status
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { attemptCount: Number(row.attempt_count), status: row.status };
  });
}
