/**
 * `POST /conversations/:id/scheduled-messages` — Programar mensagem: a text
 * frozen now, sent by the due tick at `scheduledAt`.
 *
 * Moved from `apps/api/src/scheduled/routes.ts` and `scheduled/prisma.ts`
 * (`create`). Confirming never sends; it writes one `SCHEDULED` row.
 *
 * TWO TRANSACTIONS AND A PROBE BETWEEN THEM. The conversation is read in one
 * `db.tx`; the LIVE channel probe — an outbound call — runs outside any
 * transaction (never await a provider inside `db.tx`); then the service
 * occupancy check and the insert share a second `db.tx`, so no other schedule
 * can take the service between the check and the write.
 */
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma } from "@select-lub/core/db";
import { SCHEDULE_TIME_ZONE } from "../../services/contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { channelStatusSchema } from "../../channel/contracts/http.js";
import {
  createScheduledMessageBodySchema,
  scheduleConflictErrorSchema,
  scheduledMessageSchema,
  type CreateScheduledMessageBody,
  type ScheduledMessage,
} from "../contracts/http.js";
import { emptyBody, idParams } from "../internal/params.js";
import type { SchedulingPorts } from "../internal/ports.js";
import { toScheduleDto } from "../internal/schedule-dto.js";

/** Request and response schemas. */
export const schema = {
  params: idParams,
  body: createScheduledMessageBodySchema,
  response: {
    201: scheduledMessageSchema,
    401: emptyBody,
    404: emptyBody,
    409: z.union([channelStatusSchema, scheduleConflictErrorSchema]),
  },
};

/** What the insert needs beyond the conversation. */
export type CreateScheduleInput = {
  text: string;
  scheduledAt: Date;
  conversationId: string;
  customerId: string | null;
  serviceId?: string;
  templateId?: string;
  createdByUserId: string;
};

/**
 * Inserts the schedule unless its service is already occupied.
 *
 * Only a rail-created schedule occupies a service. Reminder rows are excluded:
 * a return may carry several reminders and they all name the service the
 * return came from, so counting them would make the rail action unreachable
 * after the first.
 *
 * @param tx - A client under `module_scheduling`, inside one transaction.
 * @param input - See {@link CreateScheduleInput}.
 * @returns The schedule, or `conflict` when a non-cancelled rail schedule
 *   already names the service.
 * @throws Prisma `P2002` when the partial unique index refuses the row; the
 *   handler maps it to `conflict` too.
 */
export async function insertSchedule(
  tx: DbClient,
  input: CreateScheduleInput,
): Promise<{ status: "ok"; schedule: ScheduledMessage } | { status: "conflict" }> {
  if (input.serviceId) {
    const occupied = await tx.scheduledMessage.findFirst({
      where: { serviceId: input.serviceId, returnReminderMessageId: null, status: { not: "CANCELLED" } },
      select: { id: true },
    });
    if (occupied) {
      return { status: "conflict" };
    }
  }
  const row = await tx.scheduledMessage.create({
    data: {
      id: randomUUID(),
      customerId: input.customerId,
      conversationId: input.conversationId,
      serviceId: input.serviceId ?? null,
      templateId: input.templateId ?? null,
      frozenText: input.text,
      scheduledAt: input.scheduledAt,
      timeZone: SCHEDULE_TIME_ZONE,
      status: "SCHEDULED",
      idempotencyKey: randomUUID(),
      createdByUserId: input.createdByUserId,
    },
  });
  return { status: "ok", schedule: toScheduleDto(row) };
}

/** A unique violation: the partial index on a service's rail schedule. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Builds the handler over the channel probe.
 *
 * @param ports - See {@link SchedulingPorts}.
 * @returns 201 with the schedule; 404; 401 with no session user; 409
 *   `{ state: "DISCONNECTED" }` while the channel is down; 409
 *   `{ error: "conflict" }` when the service is occupied.
 */
export function createHandler(ports: SchedulingPorts) {
  return async (
    request: FastifyRequest<{ Params: z.infer<typeof idParams>; Body: CreateScheduledMessageBody }>,
    reply: FastifyReply,
  ) => {
    const unitId = unitIdOf(request);
    if (!unitId) {
      return reply.code(404).send({});
    }
    const createdByUserId = request.crmUserId;
    if (!createdByUserId) {
      return reply.code(401).send({});
    }
    const conversationId = request.params.id;
    const conversation = await request.server.db.tx("scheduling", (tx) =>
      tx.conversation.findFirst({
        where: { id: conversationId, whatsappConnection: { unitId } },
        select: { id: true, customerId: true },
      }),
    );
    if (!conversation) {
      return reply.code(404).send({});
    }
    if (!(await ports.channelConnected())) {
      return reply.code(409).send({ state: "DISCONNECTED" });
    }
    const body = request.body;
    try {
      const result = await request.server.db.tx("scheduling", (tx) =>
        insertSchedule(tx, {
          text: body.text,
          scheduledAt: new Date(body.scheduledAt),
          conversationId,
          customerId: conversation.customerId,
          serviceId: body.serviceId,
          templateId: body.templateId,
          createdByUserId,
        }),
      );
      if (result.status === "conflict") {
        return reply.code(409).send({ error: "conflict" });
      }
      return reply.code(201).send(result.schedule);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "conflict" });
      }
      throw error;
    }
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
    path: "/conversations/:id/scheduled-messages",
    schema,
    handler: createHandler(ports),
  };
}
