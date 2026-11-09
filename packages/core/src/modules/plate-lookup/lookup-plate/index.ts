/**
 * `POST /plate-lookups` — suggested vehicle fields for a plate, from the cache
 * or the configured provider. Never writes `vehicle` or `customer`.
 *
 * Purpose, kind, tables written and invariants: see `AGENTS.md` beside this
 * file. The one that shapes the code below: every query runs in its OWN
 * `db.tx`, and the provider call runs in none. A billed hop is committed the
 * moment it is recorded, so a cache write that fails afterwards cannot roll
 * back the record of a charge the provider has already made.
 */
import { Prisma } from "@prisma/client";
import { parsePlate, stripOwnerIdentifyingKeys, type LookupResult } from "../../../kernel/clients/placas/index.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlateProvider } from "../../../kernel/clients/index.js";
import { unitIdOf, type Db, type SliceRoute } from "../../../kernel/index.js";
import {
  invalidPlateErrorSchema,
  plateLookupBodySchema,
  plateLookupResponseSchema,
  type PlateLookupBody,
  type PlateLookupResponse,
  type PlateSuggestionFields,
} from "../contracts/http.js";

/** One cached resolution or miss, keyed on the normalized plate. */
interface CachedPlate {
  plate: string;
  outcome: "resolved" | "miss";
  provider: string;
  fields: PlateSuggestionFields | null;
  lookedUpAt: string;
}

/** Result of {@link lookupPlate}: an HTTP 200 body, or a 422 for an invalid plate. */
export type PlateLookupOutcome =
  | { statusCode: 200; body: PlateLookupResponse }
  | { statusCode: 422; body: { code: "invalid_plate" } };

/** What {@link lookupPlate} needs besides the database. */
export interface LookupPlatePorts {
  /** The composed provider, or `null` when the feature is inactive. */
  readonly plateProvider: PlateProvider | null;
  /** Clock for `lookedUpAt` and `billedAt`; defaults to the wall clock. */
  readonly now?: () => Date;
}

async function readCached(db: Db, plate: string): Promise<CachedPlate | null> {
  const row = await db.tx("plate-lookup", (tx) => tx.plateLookup.findUnique({ where: { plate } }));
  if (!row) return null;
  return {
    plate: row.plate,
    // Anything but "miss" is a resolution, as the old adapter read it: a
    // database seeded before #132 still holds the seed's former "found" (W2-C8).
    outcome: row.outcome === "miss" ? "miss" : "resolved",
    provider: row.provider,
    fields: (row.fields ?? null) as PlateSuggestionFields | null,
    lookedUpAt: row.lookedUpAt.toISOString(),
  };
}

async function saveCached(db: Db, row: CachedPlate & { rawPayload: unknown }): Promise<void> {
  // `fields` and `raw_payload` are `Json?`: SQL NULL and JSON null differ, so a
  // miss is written as DbNull and read back as `null`.
  const data = {
    outcome: row.outcome,
    provider: row.provider,
    fields: row.fields === null ? Prisma.DbNull : (row.fields as Prisma.InputJsonValue),
    rawPayload:
      row.rawPayload === undefined || row.rawPayload === null
        ? Prisma.DbNull
        : (row.rawPayload as Prisma.InputJsonValue),
    lookedUpAt: new Date(row.lookedUpAt),
  };
  await db.tx("plate-lookup", (tx) =>
    tx.plateLookup.upsert({
      where: { plate: row.plate },
      create: { plate: row.plate, ...data },
      update: data,
    }),
  );
}

async function recordHop(
  db: Db,
  hop: { plate: string; provider: string; outcome: string; unitId: string | null; billedAt: Date },
): Promise<void> {
  await db.tx("plate-lookup", (tx) => tx.plateLookupCall.create({ data: hop }));
}

function fieldsOf(result: Extract<LookupResult, { status: "found" }>): PlateSuggestionFields {
  const fields: PlateSuggestionFields = {};
  if (result.fields.make !== undefined) fields.make = result.fields.make;
  if (result.fields.model !== undefined) fields.model = result.fields.model;
  if (result.fields.version !== undefined) fields.version = result.fields.version;
  if (result.fields.year !== undefined) fields.year = result.fields.year;
  if (result.fields.displacementCc !== undefined) fields.displacementCc = result.fields.displacementCc;
  if (result.fields.fuel !== undefined) fields.fuel = result.fields.fuel;
  return fields;
}

/**
 * Runs one lookup against the cache and the configured provider.
 *
 * A malformed plate never reaches the provider. Mock results are neither
 * cached nor ledgered. Failures are not cached. A stored miss is served until
 * `retry` is true.
 *
 * @param db - The handle; every query runs under the `plate-lookup` role.
 * @param input.plate - Raw plate text from the request body.
 * @param input.retry - When true, a stored miss is ignored and the provider is called again.
 * @param input.unitId - The caller's unit, recorded on billed hops only.
 * @param ports - See {@link LookupPlatePorts}.
 * @returns 200 with a discriminated body, or 422 for an invalid plate.
 */
export async function lookupPlate(
  db: Db,
  input: { plate: string; retry?: boolean; unitId?: string },
  ports: LookupPlatePorts,
): Promise<PlateLookupOutcome> {
  const plate = parsePlate(input.plate);
  if (!plate) {
    return { statusCode: 422, body: { code: "invalid_plate" } };
  }
  const provider = ports.plateProvider;
  if (!provider) {
    return { statusCode: 200, body: { status: "unavailable" } };
  }

  const now = ports.now ?? (() => new Date());
  const stored = await readCached(db, plate);
  const skipCache = Boolean(input.retry && stored?.outcome === "miss");
  if (stored && !skipCache) {
    if (stored.outcome === "resolved" && stored.fields) {
      return {
        statusCode: 200,
        body: {
          status: "found",
          source: "provider",
          provider: stored.provider,
          cached: true,
          fields: stored.fields,
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        status: "not_found",
        source: "provider",
        provider: stored.provider,
        cached: true,
        lookedUpAt: stored.lookedUpAt,
        recordedOutcome: "miss",
      },
    };
  }

  // Outside any transaction: this is a network call, and it is the one that costs.
  const result = await provider.lookup(plate);
  const billedAt = now();
  const isMock = result.status !== "failed" && result.source === "mock";

  if (!isMock) {
    for (const hop of result.billedCalls) {
      await recordHop(db, {
        plate,
        provider: hop.provider,
        outcome: hop.outcome,
        unitId: input.unitId ?? null,
        billedAt,
      });
    }
  }

  if (result.status === "failed") {
    return { statusCode: 200, body: { status: "failed", reason: result.reason } };
  }

  if (!isMock) {
    await saveCached(db, {
      plate,
      outcome: result.status === "found" ? "resolved" : "miss",
      provider: result.provider,
      fields: result.status === "found" ? fieldsOf(result) : null,
      rawPayload: result.status === "found" ? stripOwnerIdentifyingKeys(result.raw) : null,
      lookedUpAt: billedAt.toISOString(),
    });
  }

  if (result.status === "found") {
    return {
      statusCode: 200,
      body: {
        status: "found",
        source: result.source,
        provider: result.provider,
        cached: false,
        fields: fieldsOf(result),
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: "not_found",
      source: result.source,
      provider: result.provider,
      cached: false,
      lookedUpAt: billedAt.toISOString(),
      recordedOutcome: "miss",
    },
  };
}

/** The route's schema, validated and serialised by Fastify at the entry. */
export const lookupPlateSchema = {
  body: plateLookupBodySchema,
  response: { 200: plateLookupResponseSchema, 422: invalidPlateErrorSchema },
};

/**
 * The slice's route, with the module's ports closed over.
 *
 * The module's `createHttpPlugin(ports)` and this slice's tests both mount the
 * route this returns, so production and the tests serve the identical route.
 *
 * No unit-ownership check: a plate is not owned by a shop. The unit is read
 * only to attribute a billed hop's spend.
 *
 * @param ports - The provider this app was built with.
 * @returns The route to register.
 */
export function route(ports: {
  readonly plateProvider: PlateProvider | null;
}): SliceRoute<typeof lookupPlateSchema> {
  return {
    method: "POST",
    path: "/plate-lookups",
    schema: lookupPlateSchema,
    handler: async (request: FastifyRequest<{ Body: PlateLookupBody }>, reply: FastifyReply) => {
      const outcome = await lookupPlate(
        request.server.db,
        { plate: request.body.plate, retry: request.body.retry, unitId: unitIdOf(request) },
        { plateProvider: ports.plateProvider },
      );
      return reply.code(outcome.statusCode).send(outcome.body);
    },
  };
}
