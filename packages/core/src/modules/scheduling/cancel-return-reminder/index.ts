/**
 * `POST /return-reminders/:reminderMessageId/cancel` — stop a reminder message
 * and every one of its un-sent moments.
 *
 * Moved from `apps/api/src/return-reminders/routes.ts` and `prisma.ts`
 * (`cancel`); the write itself from `packages/db/src/return-reminders.ts`.
 * No channel check: stopping a message never sends anything, so a down channel
 * must not trap the operator with reminders they cannot cancel. With no
 * provider call to keep out, the scope check, the cancel and the read-back are
 * one `db.tx`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { returnReminderMessageSchema } from "../contracts/http.js";
import { emptyBody, reminderMessageParams } from "../internal/params.js";
import {
  reminderConflictSchema,
  sendReminderResult,
  type ReminderWriteResult,
} from "../internal/reminder-reply.js";
import { readReminderMessage } from "../internal/reminder-dto.js";
import { cancelReminder } from "./cancel-reminder.js";

// The write itself, for this slice's tests.
export { cancelReminder } from "./cancel-reminder.js";

/** Request and response schemas. */
export const schema = {
  params: reminderMessageParams,
  response: {
    200: returnReminderMessageSchema,
    401: emptyBody,
    403: emptyBody,
    404: emptyBody,
    409: reminderConflictSchema,
  },
};

/**
 * The handler: 200 with the cancelled message, 403 without a unit, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - The reply.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof reminderMessageParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(403).send({});
  }
  const { reminderMessageId } = request.params;
  const result = await request.server.db.tx("scheduling", async (tx): Promise<ReminderWriteResult> => {
    const row = await tx.returnReminderMessage.findFirst({
      where: { id: reminderMessageId, vehicleReturn: { sourceService: { unitId } } },
      select: { id: true },
    });
    if (!row) {
      return { status: "not_found" };
    }
    await cancelReminder(tx, reminderMessageId);
    return { status: "ok", message: await readReminderMessage(tx, reminderMessageId) };
  });
  return sendReminderResult(reply, result, 200);
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/return-reminders/:reminderMessageId/cancel",
  schema,
  handler,
};
