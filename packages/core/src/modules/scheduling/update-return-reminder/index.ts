/**
 * `PATCH /return-reminders/:reminderMessageId` — replace a reminder message's
 * un-sent moments and/or rewrite its text.
 *
 * Moved from `apps/api/src/return-reminders/routes.ts` and `prisma.ts`
 * (`update`); the write itself from `packages/db/src/return-reminders.ts`.
 * `triggers` is the complete desired un-sent set, not a delta. The message must
 * hang off a return of the caller's loja. An edit can add a moment, so the same
 * channel block a confirm carries applies: the LIVE probe, outside any
 * transaction. The answer carries every row, sent ones included, so the overlay
 * redraws from the response without merge logic.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import {
  returnReminderMessageSchema,
  updateReturnReminderBodySchema,
  type UpdateReturnReminderBody,
} from "../contracts/http.js";
import { emptyBody, reminderMessageParams } from "../internal/params.js";
import type { SchedulingPorts } from "../internal/ports.js";
import {
  reminderConflictSchema,
  sendReminderResult,
  toTrigger,
  type ReminderWriteResult,
} from "../internal/reminder-reply.js";
import { readReminderMessage } from "../internal/reminder-dto.js";
import { updateReminder } from "./update-reminder.js";

// The write itself, for this slice's tests: they drive it with an injected
// clock, which the route does not take.
export { updateReminder, type UpdateReturnReminderResult } from "./update-reminder.js";

/** Request and response schemas. */
export const schema = {
  params: reminderMessageParams,
  body: updateReturnReminderBodySchema,
  response: {
    200: returnReminderMessageSchema,
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
 * @returns 200 with the message and every row; 403 without a unit or user; 404;
 *   409 with the refusal.
 */
export function createHandler(ports: SchedulingPorts) {
  return async (
    request: FastifyRequest<{
      Params: z.infer<typeof reminderMessageParams>;
      Body: UpdateReturnReminderBody;
    }>,
    reply: FastifyReply,
  ) => {
    const unitId = unitIdOf(request);
    const userId = request.crmUserId;
    if (!unitId || !userId) {
      return reply.code(403).send({});
    }
    const { reminderMessageId } = request.params;
    const db = request.server.db;
    const row = await db.tx("scheduling", (tx) =>
      tx.returnReminderMessage.findFirst({
        where: { id: reminderMessageId, vehicleReturn: { sourceService: { unitId } } },
        select: { id: true },
      }),
    );
    if (!row) {
      return sendReminderResult(reply, { status: "not_found" }, 200);
    }
    if (!(await ports.channelConnected())) {
      return sendReminderResult(reply, { status: "channel_down" }, 200);
    }
    const result = await db.tx("scheduling", async (tx): Promise<ReminderWriteResult> => {
      const updated = await updateReminder(tx, {
        reminderMessageId,
        triggers: request.body.triggers?.map(toTrigger),
        bodyTemplate: request.body.bodyTemplate,
        createdByUserId: userId,
      });
      if (updated.status !== "ok") {
        return updated;
      }
      return { status: "ok", message: await readReminderMessage(tx, reminderMessageId) };
    });
    return sendReminderResult(reply, result, 200);
  };
}

/**
 * The slice's route over the given ports; the path is unchanged from `apps/api`.
 *
 * @param ports - See {@link SchedulingPorts}.
 */
export function createRoute(ports: SchedulingPorts): SliceRoute<typeof schema> {
  return {
    method: "PATCH",
    path: "/return-reminders/:reminderMessageId",
    schema,
    handler: createHandler(ports),
  };
}
