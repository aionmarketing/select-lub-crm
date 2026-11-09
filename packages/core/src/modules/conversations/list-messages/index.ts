/**
 * `GET /conversations/:id/messages` — a thread: its canonical messages and the
 * sends still in flight, in time order.
 *
 * Moved from `apps/api/src/conversations/routes.ts` and `messages()` in
 * `conversations/prisma.ts` (4A), queries unchanged. The loja check, the message
 * read and the outbox read run in one `db.tx("conversations", …)`, so the thread
 * is one snapshot; `outbox_message` is channel's table, read under
 * `module_conversations` (`readableBy "*"`).
 */
import { conversationMessageListSchema, type ConversationMessage, type OutboxStatus } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { messageFrom } from "../internal/conversation-dto.js";
import { outboxFailureOf, resentOutboxIds, scheduledCopyKeys } from "../internal/outbox-failure.js";
import { conversationIdParams, emptyBody } from "../internal/params.js";

/**
 * Reads a thread of the loja.
 *
 * @param db - The database handle.
 * @param unitId - The request's loja.
 * @param conversationId - The path id.
 * @returns The messages oldest first, or null when the conversation is unknown
 *   or another loja's. An outbox row appears until it is `confirmed`, when the
 *   canonical message the drain inserted takes its place.
 */
export async function listMessages(
  db: Db,
  unitId: string,
  conversationId: string,
): Promise<ConversationMessage[] | null> {
  const read = await db.tx("conversations", async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, whatsappConnection: { unitId } },
      select: { id: true },
    });
    if (!conversation) {
      return null;
    }
    const rows = await tx.message.findMany({ where: { conversationId }, orderBy: { providerTimestamp: "asc" } });
    const pending = await tx.outboxMessage.findMany({
      where: { conversationId, NOT: { status: "confirmed" } },
      orderBy: { createdAt: "asc" },
    });
    // Only a blocked row needs the look-up: a blocked scheduled copy keeps its label.
    const scheduledKeys = await scheduledCopyKeys(
      tx,
      pending.filter((row) => row.status === "blocked").map((row) => row.idempotencyKey),
    );
    // A row already resent shows "Reenviada" (hold-unknown-followups): a failed
    // one, or a blocked one the resend cancelled. The copy may be confirmed by
    // now, so it is looked up by key, not among `pending`.
    const resent = await resentOutboxIds(
      tx,
      pending.filter((row) => row.status === "failed" || row.status === "cancelled").map((row) => row.id),
    );
    return { rows, pending, scheduledKeys, resent };
  });
  if (!read) {
    return null;
  }
  const canonical = read.rows.map((row) =>
    messageFrom({
      id: row.id,
      direction: row.direction as ConversationMessage["direction"],
      messageType: row.messageType as ConversationMessage["messageType"],
      textBody: row.textBody,
      providerTimestamp: row.providerTimestamp,
      providerStatus: (row.providerStatus as ConversationMessage["providerStatus"]) ?? undefined,
      contentUnavailable: row.contentUnavailable,
      shouldReply: row.shouldReply,
    }),
  );
  const inFlight = read.pending.map((row) =>
    messageFrom({
      id: row.id,
      direction: "outbound",
      messageType: row.messageType as ConversationMessage["messageType"],
      textBody: row.textBody,
      providerTimestamp: row.createdAt,
      outboxStatus: row.status as OutboxStatus,
      outboxFailure: outboxFailureOf(row, read.scheduledKeys),
      outboxResent: read.resent.has(row.id),
    }),
  );
  return [...canonical, ...inFlight].sort(
    (a, b) => new Date(a.providerTimestamp).getTime() - new Date(b.providerTimestamp).getTime(),
  );
}

/** Request and response schemas. */
export const schema = {
  params: conversationIdParams,
  response: { 200: conversationMessageListSchema, 404: emptyBody },
};

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/conversations/:id/messages",
  schema,
  handler: async (request: FastifyRequest<{ Params: z.infer<typeof conversationIdParams> }>, reply: FastifyReply) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(404).send({});
    }
    const messages = await listMessages(request.server.db, unitId, request.params.id);
    if (!messages) {
      return reply.code(404).send({});
    }
    return messages;
  },
};
