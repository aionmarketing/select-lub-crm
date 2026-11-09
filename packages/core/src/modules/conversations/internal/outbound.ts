/**
 * Queues an attendant's send through channel's outbox contract and shapes the
 * row as the thread's in-flight message.
 *
 * Moved from `enqueue` / `enqueueMedia` in `apps/api/src/conversations/prisma.ts`
 * (4A). The caller has already checked the loja and asked the LIVE probe; this is
 * reached only when the probe said connected, so the row is always queued with
 * `connected: true`. A resubmitted `idempotencyKey` gets its row back untouched
 * (`onExisting: "keep"`), never re-sent — exactly-once stands.
 *
 * `outbox_message` is channel's table; the write runs in channel's own
 * `db.tx("channel", …)` inside `enqueueOutbound`, and nothing here awaits a
 * provider.
 */
import type { ConversationMessage, OutboxStatus } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { enqueueOutbound, type OutboundMessageType } from "../../channel/contracts/enqueue-outbound.js";
import { isMediaMessageType, messageFrom } from "./conversation-dto.js";

/** One send, text or media. */
export type OutboundSend = {
  conversationId: string;
  messageType: OutboundMessageType;
  /** The text, or the trimmed caption; null for media with none. */
  textBody: string | null;
  media?: { bytes: Uint8Array; mimeType: string; fileName: string };
  idempotencyKey?: string;
};

/**
 * Queues the send, or finds the row its key already queued.
 *
 * @param db - The database handle.
 * @param send - See {@link OutboundSend}.
 * @returns The thread message the send stands for: the new row as `queued`, or
 *   the existing row as it stands.
 */
export async function queueOutbound(db: Db, send: OutboundSend): Promise<ConversationMessage> {
  const row = await enqueueOutbound(db, {
    conversationId: send.conversationId,
    messageType: send.messageType,
    textBody: send.textBody,
    ...(send.media ? { media: send.media } : {}),
    idempotencyKey: send.idempotencyKey ?? null,
    connected: true,
    onExisting: "keep",
  });
  if (!row.created) {
    return messageFrom({
      id: row.id,
      direction: "outbound",
      messageType: isMediaMessageType(row.messageType) ? row.messageType : "text",
      textBody: row.textBody,
      providerTimestamp: row.createdAt,
      outboxStatus: row.status as OutboxStatus,
    });
  }
  return messageFrom({
    id: row.id,
    direction: "outbound",
    messageType: send.messageType,
    textBody: send.textBody,
    providerTimestamp: new Date(),
    outboxStatus: "queued",
  });
}
