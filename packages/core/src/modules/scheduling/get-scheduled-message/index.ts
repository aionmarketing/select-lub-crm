/**
 * `GET /scheduled-messages/:id` — one scheduled message in full, for the rail
 * drill-in: frozen text, instant and zone, status, the recorded error when it
 * failed, and the template, originating service and creator by name.
 *
 * Moved from `apps/api/src/scheduled/routes.ts` and `scheduled/prisma.ts`
 * (`detail`). Not nested under the conversation: the rail drill-in and a
 * Follow-up link both reach a message by its own id, and the read scopes it to
 * the unit through its conversation either way. Reads `template` (conversations'
 * table), `user` (accounts') and `service` (services') under `readableBy`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { scheduledMessageDetailSchema, type ScheduledMessageDetail } from "../contracts/http.js";
import { emptyBody, idParams } from "../internal/params.js";
import { toScheduleDetailDto } from "../internal/schedule-dto.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  response: { 200: scheduledMessageDetailSchema, 404: emptyBody },
};

/**
 * Reads one scheduled message with its labels, if it is in the unit.
 *
 * One query: three follow-up round trips would render the drill-in before it
 * could name any of them. A row whose conversation is null, or hangs off
 * another loja's connection, fails the same join and is `null`.
 *
 * @param tx - A client under `module_scheduling`.
 * @param unitId - Loja that must own the message's conversation.
 * @param scheduleId - The scheduled message.
 * @returns The detail, or `null` when missing or out of unit.
 */
export async function getScheduledMessage(
  tx: DbClient,
  unitId: string,
  scheduleId: string,
): Promise<ScheduledMessageDetail | null> {
  const row = await tx.scheduledMessage.findFirst({
    where: { id: scheduleId, conversation: { whatsappConnection: { unitId } } },
    include: {
      template: { select: { name: true } },
      createdByUser: { select: { name: true } },
      service: { select: { id: true, omieId: true, description: true, performedAt: true } },
    },
  });
  if (!row) {
    return null;
  }
  return toScheduleDetailDto(row, {
    templateName: row.template?.name ?? null,
    createdByName: row.createdByUser?.name ?? null,
    originatingService: row.service ?? null,
  });
}

/**
 * The handler: 200 with the detail, or 404.
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
  const detail = await request.server.db.tx("scheduling", (tx) =>
    getScheduledMessage(tx, unitId, request.params.id),
  );
  if (!detail) {
    return reply.code(404).send({});
  }
  return detail;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/scheduled-messages/:id",
  schema,
  handler,
};
