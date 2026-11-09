/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/plate-lookup/routes.test.ts (wave 2, stream 2A of
 * adopt-modular-vertical-slices): three of its four cases. Module role: every
 * query ran under `module_plate_lookup`, through `db.tx("plate-lookup", …)`.
 *
 * Setup: `POST /plate-lookups` through `inject`, on the kernel app from
 * `buildSliceApp`, with the slice's own `route(ports)` mounted by
 * `registerSlice` — the identical route the module's `createHttpPlugin`
 * mounts in production. The database is the test's rolling-back transaction.
 *
 * WHAT IS NOT HERE, AND WHERE IT WENT. `buildSliceApp` has no auth hook: the
 * caller is stated by the test and written onto the request fields that
 * `apps/api`'s hook would have set. So the fourth case, "401 when
 * unauthenticated", moved to apps/api/test/plate-lookup.integration.test.ts,
 * beside the hook, together with the attribution case run through the REAL
 * hook's `X-Unit-Id` resolution (ruling W2-C9). This file keeps one
 * attribution assertion of its own, through the stated caller: it pins the
 * slice's use of `unitIdOf`, where the apps/api case pins the hook's
 * resolution — a different defect fails each.
 *
 * NO TEST HERE MAY REACH A REAL PROVIDER. The provider is passed explicitly to
 * `route(ports)` in every case — a local counting object, or `null` for the
 * inactive case — and the slice has no fallback that could construct a real
 * one. Every case with a provider asserts its call count, zero on the refusal
 * path.
 *
 * Plates are generated per run: `plate_lookup.plate` is unique.
 *
 * Spec: a malformed plate is 422 and spends nothing; a successful lookup
 * returns the fields and bills one hop against the caller's unit; an inactive
 * provider reports `unavailable` and writes nothing.
 *
 * Axes
 *   A2 plate — valid / malformed
 *   A3 provider — injected and answering / injected and never called / null
 *
 * Outputs: O2 422 with `invalid_plate`; O3 200 found; O4 200 `unavailable`;
 *   O5 the provider's call count; O6 the ledger delta and its unit
 *
 * Sampled-cell
 *   malformed plate      | A2 malformed | O2 O5 O6 | a typo becoming a billed call
 *   successful lookup    | A2 valid     | O3 O5 O6 | fields dropped, or the hop unattributed
 *   inactive provider    | A3 null      | O4 O6    | a 500, or a cache row written
 *
 * Out of scope: the auth hook (apps/api/test/plate-lookup.integration.test.ts);
 *   the cache, retry and billing decisions (lookup-plate.decisions.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { foundOrNotFound, type PlateProvider } from "../../../../kernel/clients/placas/index.js";
import { plateLookupResponseSchema } from "../../contracts/http.js";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createDb, registerSlice } from "../../../../kernel/index.js";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** A valid old-format plate (`[A-Z]{3}\d{4}`) unique to this run. */
function uniquePlate(): string {
  const letters = Array.from(
    { length: 3 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${letters}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

/** A local provider that counts what it was asked for, and answers a billed hit. */
function countingProvider(): PlateProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test",
    calls,
    async lookup(plate) {
      calls.push(plate);
      return foundOrNotFound(
        { make: "VW", model: "GOL", year: 2021 },
        { source: "provider", provider: "agregados-propria", billed: true },
      );
    },
  };
}

/**
 * Posts one plate lookup as a caller scoped to `unitId`.
 *
 * @param tx - The test transaction.
 * @param unitId - The unit the stated caller is scoped to.
 * @param plate - Request body plate.
 * @param plateProvider - The injected provider, or `null` for the inactive case.
 * @returns The raw response.
 */
async function post(tx: DbClient, unitId: string, plate: string, plateProvider: PlateProvider | null) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (instance) => registerSlice(instance, "plate-lookup", "lookup-plate", route({ plateProvider })),
    caller: { userId: randomUUID(), unitId },
  });
  try {
    return await app.inject({
      method: "POST",
      url: "/plate-lookups",
      headers: { "content-type": "application/json" },
      payload: { plate },
    });
  } finally {
    await app.close();
  }
}

describeWithDatabase("POST /plate-lookups", () => {
  it("returns 422 for a malformed plate without spending", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const provider = countingProvider();
      // A delta: the malformed input never becomes a plate to scope a count by.
      const before = await tx.plateLookupCall.count();

      const response = await post(tx, unit.id, "ZZZZZZZ", provider);

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ code: "invalid_plate" });
      expect(provider.calls).toEqual([]);
      expect(await tx.plateLookupCall.count()).toBe(before);
    }));

  it("returns a successful lookup and bills exactly one hop against the caller's unit", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const provider = countingProvider();
      const plate = uniquePlate();

      const response = await post(tx, unit.id, plate, provider);

      expect(response.statusCode).toBe(200);
      expect(plateLookupResponseSchema.parse(response.json())).toMatchObject({
        status: "found",
        fields: { make: "VW", model: "GOL", year: 2021 },
      });
      expect(provider.calls).toEqual([plate]);
      // The hop is attributed to the unit the request was scoped to — here the
      // stated caller's, read through the slice's own `unitIdOf`.
      const hops = await tx.plateLookupCall.findMany({ where: { plate } });
      expect(hops).toHaveLength(1);
      expect(hops[0]).toMatchObject({ provider: "agregados-propria", unitId: unit.id });
    }));

  it("returns unavailable when the provider is inactive", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const plate = uniquePlate();

      const response = await post(tx, unit.id, plate, null);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "unavailable" });
      expect(await tx.plateLookup.findUnique({ where: { plate } })).toBeNull();
      expect(await tx.plateLookupCall.count({ where: { plate } })).toBe(0);
    }));
});
