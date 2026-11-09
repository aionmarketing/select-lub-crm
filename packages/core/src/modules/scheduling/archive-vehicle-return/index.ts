/**
 * `POST /vehicle-returns/:returnId/archive` — take a return off both Follow-up
 * return sections. Its reminders are untouched: they keep their schedule and
 * keep sending (decided 2026-09-03).
 *
 * Moved from `apps/api/src/return-reminders/routes.ts` and `prisma.ts`
 * (`archive`). The write is to `vehicle_return`, `services`' table, so it goes
 * through `services/contracts/archive-vehicle-return.ts` and
 * runs under `module_services`. This slice writes none of scheduling's tables;
 * it lives here beside the reminder routes because that is where the screen and
 * its tests already are (3B, ruling Q1-a).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { archiveVehicleReturn } from "../../services/contracts/archive-vehicle-return.js";
import { returnReminderErrorSchema } from "../contracts/http.js";
import { emptyBody, returnParams } from "../internal/params.js";

/** Request and response schemas. 200 is `{}`: nothing else was done to count back. */
export const schema = {
  params: returnParams,
  response: {
    200: emptyBody,
    401: emptyBody,
    403: emptyBody,
    404: emptyBody,
    409: returnReminderErrorSchema,
  },
};

/**
 * The handler: 200 `{}`; 403 without a unit or user; 404 for an unknown return
 * or another loja's; 409 `return_not_open` for one that is not `OPEN`.
 *
 * @param request - Parsed params; the hook has set the caller's unit and user.
 * @param reply - The reply.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof returnParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  const userId = request.crmUserId;
  if (!unitId || !userId) {
    return reply.code(403).send({});
  }
  const { returnId } = request.params;
  const db = request.server.db;
  const row = await db.tx("scheduling", (tx) =>
    tx.vehicleReturn.findFirst({
      where: { id: returnId, sourceService: { unitId } },
      select: { status: true },
    }),
  );
  if (!row) {
    return reply.code(404).send({});
  }
  if (row.status !== "OPEN") {
    return reply.code(409).send({ error: "return_not_open" });
  }
  await archiveVehicleReturn(db, { returnId, userId });
  return reply.code(200).send({});
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "POST",
  path: "/vehicle-returns/:returnId/archive",
  schema,
  handler,
};
