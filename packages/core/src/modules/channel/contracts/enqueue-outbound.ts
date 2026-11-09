/**
 * Queues one outbound WhatsApp message. With {@link cancelOutbound}, the only way
 * anything outside `channel` writes `outbox_message`.
 *
 * It runs on `db.tx("channel", …)`, so the write is made under channel's role
 * whoever calls it. Called from inside another transaction, it joins that
 * transaction through the kernel's savepoint, and the caller's role is restored
 * on exit.
 *
 * TWO CALLERS, TWO MEANINGS, AND THE CALLER CHOOSES (wave 3, ruling Q4).
 * - The api's send (`apps/api/src/conversations`) refuses before calling this
 *   when the LIVE Evolution probe says disconnected, so it only ever passes
 *   `connected: true`. On an existing idempotency key it wants that row back
 *   UNTOUCHED — a double-submit must not resend. It passes `onExisting: "keep"`.
 * - The scheduled due-tick (`apps/worker/src/scheduled`) decides from the STORED
 *   `connection_state` column and always writes: a new row is `queued` or
 *   `blocked`, and an existing row is re-blocked or unblocked to match. It passes
 *   `onExisting: "reconcile"`.
 * Connectivity is an INPUT for that reason. Reading either source here would
 * silently change the other caller: the live-vs-stored split is deliberate
 * (memory: connectivity-has-two-sources-column-and-probe).
 *
 * THE RACE THIS CLOSES (ruling Q1-A). The due-tick used to read the existing row
 * and then update it BY ID with no status guard. While it ran in the same tick as
 * the drain that could not interleave; as separate jobs it can: the due-tick
 * reads `queued`, the drain claims, sends and confirms it, the due-tick writes
 * `blocked` over the confirmed row, and on reconnect it flips back to `queued` and
 * is SENT AGAIN. Both reconcile transitions are therefore compare-and-set — the
 * `where` carries the statuses the transition is allowed from — so a claimed,
 * sent or confirmed row can never be touched, however the jobs interleave.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../../../kernel/db.js";

/**
 * The `last_error` a row carries while it is blocked for a disconnected channel.
 *
 * Byte-identical to the scheduled due-tick's `CONNECTION_DISCONNECTED`, which
 * also writes it onto `scheduled_message`; the two must agree.
 */
export const OUTBOX_BLOCKED_DISCONNECTED = "connection_disconnected";

/** The message types an outbox row may carry. */
export type OutboundMessageType = "text" | "image" | "audio" | "video" | "document";

/** One message to queue. */
export interface EnqueueOutboundInput {
  readonly conversationId: string;
  /** Defaults to `text`. */
  readonly messageType?: OutboundMessageType;
  /** The text, or a media caption; `null` for media sent without one. */
  readonly textBody: string | null;
  /** Present for media rows only. */
  readonly media?: {
    readonly bytes: Uint8Array;
    readonly mimeType: string | null;
    readonly fileName: string | null;
  };
  /** Dedupes a resubmission. Omitted, every call creates a row. */
  readonly idempotencyKey?: string | null;
  /**
   * Whether the CALLER considers the channel connected, from the caller's own
   * source. Decides a new row's status: `queued` when true, `blocked` when false.
   */
  readonly connected: boolean;
  /**
   * What to do when `idempotencyKey` already has a row:
   * - `keep` returns it untouched (the api's double-submit).
   * - `reconcile` re-blocks it (`queued`/`blocked` → `blocked`) when not
   *   connected, or unblocks it (`blocked` → `queued`) when connected, each only
   *   from those statuses. A `cancelled`, `claimed`, `sent`, `confirmed` or
   *   `failed` row is never changed.
   */
  readonly onExisting: "keep" | "reconcile";
}

/** The row as it stands after the call. */
export interface EnqueuedOutbound {
  readonly id: string;
  readonly messageType: string;
  readonly textBody: string | null;
  readonly status: string;
  readonly createdAt: Date;
  /** True when this call created the row; false when the key already had one. */
  readonly created: boolean;
}

/**
 * Queues one outbound message, or finds the one already queued for its key.
 *
 * @param db - The database handle; the write runs on `db.tx("channel", …)`.
 * @param input - See {@link EnqueueOutboundInput}.
 * @returns The row after the call, and whether this call created it.
 */
export async function enqueueOutbound(db: Db, input: EnqueueOutboundInput): Promise<EnqueuedOutbound> {
  return db.tx("channel", async (tx) => {
    const key = input.idempotencyKey ?? null;
    if (key !== null) {
      const existing = await tx.outboxMessage.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (input.onExisting === "reconcile") {
          if (input.connected) {
            // The unblock also writes the caller's current text (owner
            // rulings, 2026-09-25): the due tick passes the schedule's frozen
            // text, so a reminder edited while its copy waited goes out with
            // the edited text even if an edit path forgot to rewrite the copy.
            await tx.outboxMessage.updateMany({
              where: { id: existing.id, status: "blocked" },
              data: {
                status: "queued",
                lastError: null,
                ...(typeof input.textBody === "string" ? { textBody: input.textBody } : {}),
              },
            });
          } else {
            await tx.outboxMessage.updateMany({
              where: { id: existing.id, status: { in: ["queued", "blocked"] } },
              data: { status: "blocked", lastError: OUTBOX_BLOCKED_DISCONNECTED },
            });
          }
        }
        const row = await tx.outboxMessage.findUniqueOrThrow({ where: { id: existing.id } });
        return {
          id: row.id,
          messageType: row.messageType,
          textBody: row.textBody,
          status: row.status,
          createdAt: row.createdAt,
          created: false,
        };
      }
    }
    const row = await tx.outboxMessage.create({
      data: {
        id: randomUUID(),
        conversationId: input.conversationId,
        messageType: input.messageType ?? "text",
        textBody: input.textBody,
        ...(input.media
          ? {
              mediaBytes: Buffer.from(input.media.bytes),
              mediaMimeType: input.media.mimeType,
              mediaFileName: input.media.fileName,
            }
          : {}),
        status: input.connected ? "queued" : "blocked",
        lastError: input.connected ? null : OUTBOX_BLOCKED_DISCONNECTED,
        idempotencyKey: key,
      },
    });
    return {
      id: row.id,
      messageType: row.messageType,
      textBody: row.textBody,
      status: row.status,
      createdAt: row.createdAt,
      created: true,
    };
  });
}
