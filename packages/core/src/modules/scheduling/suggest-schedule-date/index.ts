/**
 * `GET /services/:id/suggest-schedule-date` — the date the rail's Programar
 * mensagem pre-fills from a service: the matching interval rule's period after
 * `performedAt`, or six months.
 *
 * Moved from `apps/api/src/scheduled/routes.ts` and `scheduled/prisma.ts`
 * (`suggestForService`). A read only: nothing is written. `service` and
 * `interval_rule` are services' tables, read under `readableBy`. The rule
 * table is read whole and unscoped, as before; `suggestDate`
 * (services' `contracts/http.return-due.ts`) picks the rule.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { suggestDate } from "../../services/contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { suggestScheduleDateResultSchema, type SuggestScheduleDateResult } from "../contracts/http.js";
import { emptyBody, idParams } from "../internal/params.js";

/** Request and response schemas. 400 when the service has no performed date. */
export const schema = {
  params: idParams,
  response: { 200: suggestScheduleDateResultSchema, 400: emptyBody, 404: emptyBody },
};

/** Outcome of suggesting a follow-up date from a service. */
export type SuggestScheduleResult =
  | { status: "ok"; result: SuggestScheduleDateResult }
  | { status: "not_found" }
  | { status: "no_performed_at" };

/**
 * Suggests a follow-up date for a service in the unit.
 *
 * @param tx - A client under `module_scheduling`.
 * @param unitId - Loja that must own the service.
 * @param serviceId - The service.
 * @returns The date and its source (`rule` or `six_months`), `not_found`, or
 *   `no_performed_at`.
 */
export async function suggestScheduleDate(
  tx: DbClient,
  unitId: string,
  serviceId: string,
): Promise<SuggestScheduleResult> {
  const service = await tx.service.findFirst({ where: { id: serviceId, unitId } });
  if (!service) {
    return { status: "not_found" };
  }
  if (!service.performedAt) {
    return { status: "no_performed_at" };
  }
  const rules = await tx.intervalRule.findMany();
  const suggested = suggestDate({
    performedAt: service.performedAt,
    kind: service.kind,
    rules: rules.map((rule) => ({
      id: rule.id,
      version: rule.version,
      criterion: rule.criterion,
      criterionId: rule.criterionId,
      intervalAmount: rule.intervalAmount,
      intervalUnit: rule.intervalUnit === "days" ? "days" : "months",
      priority: rule.priority,
      active: rule.active,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
    })),
  });
  return {
    status: "ok",
    result: {
      suggestedAt: suggested.suggestedAt.toISOString(),
      suggestionSource: suggested.suggestionSource,
    },
  };
}

/**
 * The handler: 200 with the suggestion, 400, or 404.
 *
 * @param request - Parsed params; the hook has set the caller's unit.
 * @param reply - Used for the 400 and 404.
 */
export async function handler(
  request: FastifyRequest<{ Params: z.infer<typeof idParams> }>,
  reply: FastifyReply,
) {
  const unitId = unitIdOf(request);
  if (!unitId) {
    return reply.code(404).send({});
  }
  const result = await request.server.db.tx("scheduling", (tx) =>
    suggestScheduleDate(tx, unitId, request.params.id),
  );
  if (result.status === "not_found") {
    return reply.code(404).send({});
  }
  if (result.status === "no_performed_at") {
    return reply.code(400).send({});
  }
  return result.result;
}

/** The slice's route; the path is unchanged from `apps/api`. */
export const route: SliceRoute<typeof schema> = {
  method: "GET",
  path: "/services/:id/suggest-schedule-date",
  schema,
  handler,
};
