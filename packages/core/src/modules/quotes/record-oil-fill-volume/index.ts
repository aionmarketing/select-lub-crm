/**
 * `POST /vehicles/:id/oil-fill-volume` — "Guardar para este modelo" (`quotes/oil-attendant-fill`,
 * background-oil-research D24.1): keeps the fill volume an attendant typed on a missing-volume
 * quote for the vehicle's identity, so later quotes of the same car model are priced from it,
 * flagged as the attendant's, until research verifies a cited volume.
 *
 * | Request | Answer |
 * |---|---|
 * | `liters` not a number > 0 with at most two decimals | 400 (the body schema); nothing stored |
 * | a vehicle outside the caller's units, or unknown | 404 `{}` |
 * | an incomplete identity | 409 `{ reason: "incomplete_identity" }`; nothing stored |
 * | `liters` > 30 without `confirmHighVolume: true` | 422 `{ warning: "high_volume" }`; nothing stored |
 * | otherwise | 201 `{ liters, recordedBy, recordedAt }`: one `oil_attendant_fill` row |
 *
 * It inserts one row and writes nothing else — no cache row, no grade source, no research — and
 * calls no provider. The value is a human input, never a cited source, and no model ever sees it.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import {
  attendantFillSchema,
  HIGH_FILL_VOLUME_LITERS,
  highVolumeWarningSchema,
  incompleteIdentityRefusalSchema,
  oilFillVolumeBodySchema,
  type AttendantFill,
  type OilFillVolumeBody,
} from "../contracts/http.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { identityOf, missingIdentityFields } from "../internal/quote-answer/answer.js";
import { createPrismaAttendantFillStore } from "../internal/store/attendant-fill.js";
import { findVehicleInUnit } from "../internal/store/vehicle-in-unit.js";

/** What storing a volume did. */
export type RecordFillVolumeResult =
  | { status: "stored"; fill: AttendantFill }
  | { status: "not_found" }
  | { status: "incomplete_identity" }
  | { status: "high_volume" };

/**
 * Stores one typed volume for the vehicle's identity.
 *
 * @param db - The database handle; one `db.tx("quotes", …)`.
 * @param input.userId - The session user, recorded as who typed it.
 */
export async function recordOilFillVolume(
  db: Db,
  input: { vehicleId: string; unitId: string; userId: string; body: OilFillVolumeBody; now?: Date },
): Promise<RecordFillVolumeResult> {
  return db.tx("quotes", async (tx) => {
    const found = await findVehicleInUnit(tx, input.vehicleId, input.unitId);
    if (!found) return { status: "not_found" };
    if (missingIdentityFields(found.vehicle).length > 0) return { status: "incomplete_identity" };
    if (input.body.liters > HIGH_FILL_VOLUME_LITERS && input.body.confirmHighVolume !== true) return { status: "high_volume" };
    const row = await createPrismaAttendantFillStore(tx).insert({
      identity: identityOf(found.vehicle),
      liters: input.body.liters,
      recordedByUserId: input.userId,
      ...(input.now ? { recordedAt: input.now } : {}),
    });
    return { status: "stored", fill: { liters: row.liters, recordedBy: row.recordedBy, recordedAt: row.recordedAt.toISOString() } };
  });
}

const schema = {
  params: vehicleIdParams,
  body: oilFillVolumeBodySchema,
  response: {
    201: attendantFillSchema,
    404: notFoundBody,
    409: incompleteIdentityRefusalSchema,
    422: highVolumeWarningSchema,
  },
};

/**
 * The route.
 *
 * @returns The slice's route definition.
 */
export function route(): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/vehicles/:id/oil-fill-volume",
    schema,
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: OilFillVolumeBody }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId || !request.crmUserId) {
        return reply.code(404).send({});
      }
      const result = await recordOilFillVolume(request.server.db, {
        vehicleId: request.params.id,
        unitId,
        userId: request.crmUserId,
        body: request.body,
      });
      switch (result.status) {
        case "not_found":
          return reply.code(404).send({});
        case "incomplete_identity":
          return reply.code(409).send({ reason: "incomplete_identity" });
        case "high_volume":
          return reply.code(422).send({ warning: "high_volume" });
        case "stored":
          return reply.code(201).send(result.fill);
      }
    },
  };
}
