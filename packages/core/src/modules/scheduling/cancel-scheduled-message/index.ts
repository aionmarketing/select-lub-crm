/**
 * `POST /conversations/:id/scheduled-messages/:scheduleId/cancel` — stop a
 * scheduled message before it is sent.
 *
 * Moved from `apps/api/src/scheduled/routes.ts` and `scheduled/prisma.ts`
 * (`cancel`). Refused while the LIVE channel probe says disconnected, for a row
 * already `SENT`, and (owner rulings, 2026-09-25) for one whose outbox row the
 * worker has picked up — `claimed`, `sent` or `confirmed` — whatever the
 * schedule's own status: the screen must match what the customer got.
 *
 * ONE TRANSACTION FOR BOTH WRITES. The schedule is marked `CANCELLED` and its
 * outbox row cancelled together: a schedule marked cancelled whose outbox row
 * stayed `queued` would still be sent by the drain. Both go through the module's
 * `cancelUnlessPickedUp`, which every cancel path shares. The probe runs before,
 * outside any transaction.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { channelStatusSchema } from "../../channel/contracts/http.js";
import { scheduledMessageSchema, type ScheduledMessage } from "../contracts/http.js";
import { cancelUnlessPickedUp } from "../contracts/unsent.js";
import { emptyBody, scheduleParams } from "../internal/params.js";
import type { SchedulingPorts } from "../internal/ports.js";
import { toScheduleDto } from "../internal/schedule-dto.js";

/** Request and response schemas. */
export const schema = {
  params: scheduleParams,
  response: { 200: scheduledMessageSchema, 404: emptyBody, 409: channelStatusSchema },
};

/**
 * Cancels the schedule and its unsent outbox row, in the caller's transaction.
 *
 * Any row not yet `SENT` may move, as before, unless its outbox row has been
 * picked up. The schedule row is locked first, so a `SENT` row read a moment
 * ago stays `SENT` and a due tick cannot claim it mid-cancel.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param scheduleId - The schedule.
 * @returns The cancelled schedule, or `null` when it was sent meanwhile or its
 *   outbox row is already on its way; either answers `409`, and nothing changed.
 */
export async function cancelSchedule(tx: DbClient, scheduleId: string): Promise<ScheduledMessage | null> {
  const outcome = await cancelUnlessPickedUp(tx, scheduleId, { from: "not-sent", at: new Date(), lastError: null });
  if (outcome !== "cancelled") {
    return null;
  }
  return toScheduleDto(await tx.scheduledMessage.findUniqueOrThrow({ where: { id: scheduleId } }));
}

/**
 * Builds the handler over the channel probe.
 *
 * @param ports - See {@link SchedulingPorts}.
 * @returns 200 with the cancelled schedule; 404; 409 `{ state: "DISCONNECTED" }`
 *   while the channel is down; 409 `{ state: "CONNECTED" }` for a sent row, or
 *   one whose outbox row the worker has picked up.
 */
export function createHandler(ports: SchedulingPorts) {
  return async (
    request: FastifyRequest<{ Params: z.infer<typeof scheduleParams> }>,
    reply: FastifyReply,
  ) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(404).send({});
    }
    const { id: conversationId, scheduleId } = request.params;
    const row = await request.server.db.tx("scheduling", (tx) =>
      tx.scheduledMessage.findFirst({
        where: { id: scheduleId, conversationId, conversation: { whatsappConnection: { unitId } } },
        select: { status: true },
      }),
    );
    if (!row) {
      return reply.code(404).send({});
    }
    if (!(await ports.channelConnected())) {
      return reply.code(409).send({ state: "DISCONNECTED" });
    }
    if (row.status === "SENT") {
      return reply.code(409).send({ state: "CONNECTED" });
    }
    const cancelled = await request.server.db.tx("scheduling", (tx) =>
      cancelSchedule(tx, scheduleId),
    );
    if (!cancelled) {
      return reply.code(409).send({ state: "CONNECTED" });
    }
    return cancelled;
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
    path: "/conversations/:id/scheduled-messages/:scheduleId/cancel",
    schema,
    handler: createHandler(ports),
  };
}
