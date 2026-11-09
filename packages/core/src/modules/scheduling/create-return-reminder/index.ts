/**
 * `POST /vehicle-returns/:returnId/reminders` — confirm a reminder message on a
 * vehicle return: one `return_reminder_message` and one `SCHEDULED` row per
 * trigger, each with its text resolved for its own moment.
 *
 * Moved from `apps/api/src/return-reminders/routes.ts` and `prisma.ts`
 * (`create`); the write itself from `packages/db/src/return-reminders.ts`.
 * The return must be the caller's loja's, through the service it came from, and
 * so must the conversation; either failing is the same 404. Refused while the
 * LIVE channel probe says disconnected. `vehicle_return`, `service` and
 * `vehicle` are read under `readableBy`; only scheduling's two tables are written.
 *
 * The scope checks run in one `db.tx`, the probe outside any transaction, and
 * the write with its read-back in a second `db.tx`, all or nothing.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import {
  createReturnReminderBodySchema,
  returnReminderMessageSchema,
  type CreateReturnReminderBody,
} from "../contracts/http.js";
import { emptyBody, returnParams } from "../internal/params.js";
import type { SchedulingPorts } from "../internal/ports.js";
import {
  reminderConflictSchema,
  sendReminderResult,
  toTrigger,
  type ReminderWriteResult,
} from "../internal/reminder-reply.js";
import { readReminderMessage } from "../internal/reminder-dto.js";
import { createReminder } from "./create-reminder.js";

// The write itself, for this slice's tests: they drive it with an injected
// clock, which the route does not take.
export { createReminder, type CreateReturnReminderResult } from "./create-reminder.js";

/** Request and response schemas. An empty trigger list is a 400 at the schema. */
export const schema = {
  params: returnParams,
  body: createReturnReminderBodySchema,
  response: {
    201: returnReminderMessageSchema,
    401: emptyBody,
    403: emptyBody,
    404: emptyBody,
    409: reminderConflictSchema,
  },
};

/**
 * Builds the handler over the channel probe.
 *
 * @param ports - See {@link SchedulingPorts}.
 * @returns 201 with the message and every row; 403 without a unit or user; 404;
 *   409 with the refusal.
 */
export function createHandler(ports: SchedulingPorts) {
  return async (
    request: FastifyRequest<{ Params: z.infer<typeof returnParams>; Body: CreateReturnReminderBody }>,
    reply: FastifyReply,
  ) => {
    const unitId = unitIdOf(request);
    const userId = request.crmUserId;
    if (!unitId || !userId) {
      return reply.code(403).send({});
    }
    const { returnId } = request.params;
    const body = request.body;
    const db = request.server.db;
    const inUnit = await db.tx("scheduling", async (tx) => {
      const vehicleReturn = await tx.vehicleReturn.findFirst({
        where: { id: returnId, sourceService: { unitId } },
        select: { id: true },
      });
      const conversation = await tx.conversation.findFirst({
        where: { id: body.conversationId, whatsappConnection: { unitId } },
        select: { id: true },
      });
      return vehicleReturn !== null && conversation !== null;
    });
    if (!inUnit) {
      return sendReminderResult(reply, { status: "not_found" }, 201);
    }
    if (!(await ports.channelConnected())) {
      return sendReminderResult(reply, { status: "channel_down" }, 201);
    }
    const result = await db.tx("scheduling", async (tx): Promise<ReminderWriteResult> => {
      const created = await createReminder(tx, {
        returnId,
        conversationId: body.conversationId,
        triggers: body.triggers.map(toTrigger),
        bodyTemplate: body.bodyTemplate,
        templateId: body.templateId ?? null,
        createdByUserId: userId,
      });
      if (created.status !== "ok") {
        return created;
      }
      return { status: "ok", message: await readReminderMessage(tx, created.reminderMessageId) };
    });
    return sendReminderResult(reply, result, 201);
  };
}

/**
 * The slice's route over the given ports; the path is unchanged from `apps/api`.
 *
 * @param ports - See {@link SchedulingPorts}.
 */
export function createRoute(ports: SchedulingPorts): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/vehicle-returns/:returnId/reminders",
    schema,
    handler: createHandler(ports),
  };
}
