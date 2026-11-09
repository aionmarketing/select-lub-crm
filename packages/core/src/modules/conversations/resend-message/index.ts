/**
 * `POST /conversations/:id/messages/:messageId/resend` — the attendant's
 * **Reenviar** on a text message that did not go out
 * (`hold-unknown-outcome-sends`, conversas "Attendant can resend a message that
 * did not go out").
 *
 * The body is empty: the text is copied from the outbox row on the server, so the
 * resend can only send what the row already holds. Answers:
 * - 201 with the new outbox row, or with the one an earlier press queued;
 * - 404 for another loja's thread, or a row not in this conversation;
 * - 409 `{ state: "DISCONNECTED" }` when the LIVE probe says the session is down;
 * - 409 `{ error: "resend_not_allowed" }` when the row is not text, or is neither
 *   `failed` nor a `blocked` row the attendant sent.
 *
 * The probe is awaited between the reads and the write, inside neither
 * transaction (W2-C12). The write is channel's `resendUnsentOutbound`, which
 * re-checks the guard on the locked row.
 */
import { resendUnsentOutbound } from "../../channel/contracts/resend-outbound.js";
import { conversationMessageSchema, resendConflictSchema } from "../contracts/http.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { messageFrom } from "../internal/conversation-dto.js";
import { findConversationInUnit } from "../internal/conversation-scope.js";
import { scheduledCopyKeys } from "../internal/outbox-failure.js";
import { emptyBody, mediaParams } from "../internal/params.js";
import type { ConversationsPorts } from "../internal/ports.js";

/** Request and response schemas. */
export const schema = {
  params: mediaParams,
  response: { 201: conversationMessageSchema, 404: emptyBody, 409: resendConflictSchema },
};

type ResendRequest = FastifyRequest<{ Params: z.infer<typeof mediaParams> }>;

/**
 * The route, with the live probe closed over.
 *
 * @param ports - Only `channelConnected` is read.
 * @returns The slice's route.
 */
export function createRoute(ports: Pick<ConversationsPorts, "channelConnected">): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/conversations/:id/messages/:messageId/resend",
    schema,
    handler: async (request: ResendRequest, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const db = request.server.db;
      const conversation = await findConversationInUnit(db, unitId, request.params.id);
      if (!conversation) {
        return reply.code(404).send({});
      }
      // Whether the attendant sent it: a scheduled message's blocked copy stays
      // with the due tick. A row's key never changes, so this read may precede
      // the write's lock.
      const origin = await db.tx("conversations", async (tx) => {
        const row = await tx.outboxMessage.findFirst({
          where: { id: request.params.messageId, conversationId: conversation.id },
          select: { idempotencyKey: true },
        });
        if (!row) {
          return null;
        }
        const scheduled = await scheduledCopyKeys(tx, [row.idempotencyKey]);
        return { attendantSent: row.idempotencyKey === null || !scheduled.has(row.idempotencyKey) };
      });
      if (!origin) {
        return reply.code(404).send({});
      }
      if (!(await ports.channelConnected())) {
        return reply.code(409).send({ state: "DISCONNECTED" });
      }
      const outcome = await resendUnsentOutbound(db, {
        outboxId: request.params.messageId,
        conversationId: conversation.id,
        allowBlocked: origin.attendantSent,
      });
      if (outcome.status === "not_found") {
        return reply.code(404).send({});
      }
      if (outcome.status === "not_allowed") {
        return reply.code(409).send({ error: "resend_not_allowed" });
      }
      return reply.code(201).send(
        messageFrom({
          id: outcome.row.id,
          direction: "outbound",
          messageType: "text",
          textBody: outcome.row.textBody,
          providerTimestamp: outcome.row.createdAt,
          outboxStatus: outcome.row.status as z.infer<typeof conversationMessageSchema>["outboxStatus"],
        }),
      );
    },
  };
}
