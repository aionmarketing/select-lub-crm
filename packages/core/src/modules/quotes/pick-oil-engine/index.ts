/**
 * `POST /vehicles/:id/oil-research/engine-pick` — the attendant picks the engine a clarification
 * named (oil-research "An engine pick re-reads the stored source for one engine"; background-oil-
 * research D24.2, F4, G1, G2; orchestrator 2026-09-30). In this order:
 *
 * 1. **The check.** The vehicle's current identity must rest in `needs_clarification` (a second
 *    pick after the identity changed does not) — else 409 `{ reason: "not_clarification" }` — and
 *    the engine must be one it named, verbatim — else 409 `{ reason: "engine_not_named" }`. A
 *    corrected version longer than the field takes is 422 `{ error: "version_too_long" }`.
 * 2. **The enqueue**, in the same transaction as the check, through the one enqueue (D7): the
 *    corrected identity as an `engine_pick` at priority 0, with the engine and a copy of the
 *    clarification's passages; or, for a clarification that kept none (G1), a `full` research at
 *    priority 0. G2 is the enqueue's: verified runs nothing, a queued `full` or `manual_resolve`
 *    becomes the pick, a queued refetch stays one, a running research is kept. If it fails,
 *    nothing is written.
 * 3. **The version write** through the customers contract (`correctVehicleVersion`): the version
 *    computed once in step 1, as a compare-and-set on the version it was computed from, and the
 *    origin becomes `CRM`. A version changed meanwhile is 409 `{ reason: "version_changed" }` and is
 *    not written; any other failure is logged and answers 500. Either way the queued row stays (an
 *    identity no car carries is abandoned by the claim after its grace).
 * 4. **The answer**: the quote-options body for the corrected identity — `researching` with
 *    `path: "engine_pick"`, the engine and `expectedMinutes { min: 1, max: 2 }` for a queued re-read.
 *
 * It calls no provider. The earlier identity's row and every other vehicle carrying it are left
 * as they were.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { correctVehicleVersion, VEHICLE_VERSION_MAX_LENGTH, versionWithEngine } from "../../customers/contracts/correct-vehicle-version.js";
import {
  enginePickBodySchema,
  enginePickRefusalSchema,
  quoteOptionsResultSchema,
  versionTooLongSchema,
  type EnginePickBody,
  type EnginePickRefusal,
  type QuoteOptionsResult,
} from "../contracts/http.js";
import { identityKey } from "../contracts/oil-research-attention.js";
import { notFoundBody, vehicleIdParams } from "../contracts/routes.js";
import { identityOf, missingIdentityFields, readQuoteAnswer, rerunPolicy } from "../internal/quote-answer/answer.js";
import type { ClarificationPayload, StoredPassage } from "../internal/research/outcome.js";
import { enqueueResearch, type EnqueueRequest } from "../internal/research/research-store.js";
import { findVehicleInUnit } from "../internal/store/vehicle-in-unit.js";

/** What the pick did. */
export type PickEngineResult =
  | { status: "answered"; body: QuoteOptionsResult }
  | { status: "not_found" }
  | { status: "refused"; reason: EnginePickRefusal["reason"] }
  | { status: "version_too_long" }
  /** The re-read was queued; the version write failed (500). */
  | { status: "version_write_failed" };

/** The passages a stored clarification kept, in its recorded shape; empty for one recorded before PR 5. */
function passagesOf(payload: unknown): StoredPassage[] {
  const passages = (payload as Partial<ClarificationPayload> | null)?.passages;
  return Array.isArray(passages) ? passages.filter((passage) => typeof passage?.excerpt === "string" && passage.excerpt.trim() !== "") : [];
}

/**
 * Picks an engine for a vehicle whose identity rests in a clarification.
 *
 * @param db - The database handle: the check and the enqueue in one `db.tx("quotes", …)`, the
 *   version write in the customers contract's own transactions, then the answer.
 * @param omieAdapter - The Omie adapter the rail's vehicle edit takes; the version is not an Omie
 *   shared key, so it is not mirrored.
 */
export async function pickOilEngine(
  db: Db,
  omieAdapter: OmieAdapter,
  input: { vehicleId: string; unitId: string; engine: string; userId?: string; now?: Date },
): Promise<PickEngineResult> {
  const now = input.now ?? new Date();
  const engine = input.engine.trim();
  const checked = await db.tx("quotes", async (tx) => {
    const found = await findVehicleInUnit(tx, input.vehicleId, input.unitId);
    if (!found) return { status: "not_found" } as const;
    if (missingIdentityFields(found.vehicle).length > 0) return { status: "refused", reason: "not_clarification" } as const;
    const identity = identityOf(found.vehicle);
    const from = identityKey(identity)!;
    const row = await tx.oilResearch.findUnique({ where: { identityKey: from }, select: { state: true, outcomePayload: true } });
    if (row?.state !== "needs_clarification") return { status: "refused", reason: "not_clarification" } as const;
    const named = (row.outcomePayload as Partial<ClarificationPayload> | null)?.options ?? [];
    if (!named.some((option) => option.trim() === engine)) return { status: "refused", reason: "engine_not_named" } as const;
    const version = versionWithEngine(identity.version, engine);
    if (version.length > VEHICLE_VERSION_MAX_LENGTH) return { status: "version_too_long" } as const;
    const corrected = { ...identity, version };
    const passages = passagesOf(row.outcomePayload);
    const request: EnqueueRequest =
      passages.length > 0
        ? { identity: corrected, kind: "engine_pick", priority: 0, trigger: "engine_pick", enginePick: { engine, from, passages } }
        : // G1: a clarification recorded before its passages were kept researches the corrected identity.
          { identity: corrected, kind: "full", priority: 0, trigger: "engine_pick" };
    await enqueueResearch(tx, request, now, rerunPolicy());
    return { status: "queued", corrected, fromVersion: found.vehicle.version } as const;
  });
  if (checked.status !== "queued") return checked;

  // The version computed once, above, written as a compare-and-set on the version it came from.
  let written: Awaited<ReturnType<typeof correctVehicleVersion>> | null;
  try {
    written = await correctVehicleVersion(db, omieAdapter, {
      vehicleId: input.vehicleId,
      unitId: input.unitId,
      fromVersion: checked.fromVersion,
      version: checked.corrected.version,
      ...(input.userId ? { actorId: input.userId } : {}),
    });
  } catch (error) {
    console.error("oil-research", JSON.stringify({ event: "engine_pick_version_write_failed", vehicleId: input.vehicleId, error: error instanceof Error ? error.message : String(error) }));
    written = null;
  }
  if (written?.status === "version_changed") return { status: "refused", reason: "version_changed" };
  if (written?.status !== "ok") {
    if (written) console.error("oil-research", JSON.stringify({ event: "engine_pick_version_write_failed", vehicleId: input.vehicleId, status: written.status }));
    return { status: "version_write_failed" };
  }

  const body = await db.tx("quotes", (tx) => readQuoteAnswer(tx, checked.corrected, now));
  return { status: "answered", body };
}

const schema = {
  params: vehicleIdParams,
  body: enginePickBodySchema,
  response: {
    200: quoteOptionsResultSchema,
    404: notFoundBody,
    409: enginePickRefusalSchema,
    422: versionTooLongSchema,
    500: notFoundBody,
  },
};

/**
 * The route, over the module's Omie adapter.
 *
 * @param ports.omieAdapter - From `createHttpPlugin`'s closure.
 * @returns The slice's route definition.
 */
export function route(ports: { omieAdapter: OmieAdapter }): SliceRoute<typeof schema> {
  return {
    method: "POST",
    path: "/vehicles/:id/oil-research/engine-pick",
    schema,
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: EnginePickBody }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(404).send({});
      }
      const result = await pickOilEngine(request.server.db, ports.omieAdapter, {
        vehicleId: request.params.id,
        unitId,
        engine: request.body.engine,
        ...(request.crmUserId ? { userId: request.crmUserId } : {}),
      });
      switch (result.status) {
        case "not_found":
          return reply.code(404).send({});
        case "refused":
          return reply.code(409).send({ reason: result.reason });
        case "version_too_long":
          return reply.code(422).send({ error: "version_too_long" });
        case "version_write_failed":
          return reply.code(500).send({});
        case "answered":
          return result.body;
      }
    },
  };
}
