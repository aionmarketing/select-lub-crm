/**
 * `GET /conversations/:id/scheduled-messages` — a conversation's scheduled
 * messages, oldest first, for the Mensagens programadas section of the rail.
 *
 * Moved from `apps/api/src/scheduled/routes.ts` and `scheduled/prisma.ts`
 * (`list`). The conversation must hang off a connection of the caller's loja;
 * a conversation in another loja is a 404, the same as an unknown one.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { scheduledMessageListSchema, type ScheduledMessage } from "../contracts/http.js";
import { emptyBody, idParams } from "../internal/params.js";
import { toScheduleDto } from "../internal/schedule-dto.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: scheduledMessageListSchema, 404: emptyBody },
};

/**
 * Lists a conversation's schedules, if the conversation is in the unit.
 *
 * @param tx - A client under `module_scheduling`.
 * @param unitId - Loja that must own the conversation's connection.
 * @param conversationId - The conversation.
 * @returns The schedules ordered by creation, or `null` when the conversation
 *   is missing or out of unit.
 */
export async function listScheduledMessages(
  tx: DbClient,
  unitId: string,
  conversationId: string,
): Promise<ScheduledMessage[] | null> {
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId, whatsappConnection: { unitId } },
    select: { id: true },
  });
  if (!conversation) {
    return null;
  }
  const rows = await tx.scheduledMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toScheduleDto);
}

/**
 * The handler: 200 with the list, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 404.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof idParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const listed = await request.server.db.tx("scheduling", (tx) =>
    listScheduledMessages(tx, unitId, request.params.id),
  );
  if (!listed) {
    return reply.code(404).send({});
  }
  return listed;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/conversations/:id/scheduled-messages",
  schema,
  handler,
};
