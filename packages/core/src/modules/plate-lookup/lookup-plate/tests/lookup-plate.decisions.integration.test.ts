/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/plate-lookup/lookup.test.ts (wave 2, stream 2A of
 * adopt-modular-vertical-slices). Module role: every query ran under
 * `module_plate_lookup`, through `db.tx("plate-lookup", …)`.
 *
 * Setup: `lookupPlate(db, input, ports)` driven against the real cache and
 * ledger inside one rolling-back transaction per test (`withTestTransaction`)
 * on the worktree database, with a counting fake `PlateProvider`. No HTTP, no
 * Fastify. `db` is `createDb(tx, runInTransactionOnTx(tx))`, so each of the
 * slice's own transactions joins the test's.
 *
 * NO TEST HERE MAY REACH A REAL PROVIDER. Every provider in this file is a
 * local object built by {@link providerWith}, so there is no credentialed
 * client to reach and no `PLACAS_*` variable that could re-enable one; this
 * repository's exploratory tours once spent real APIBrasil credits because a
 * config blanked a variable nothing read (memory:
 * tour-config-blanks-the-wrong-plate-var). Each test additionally asserts the
 * provider's own call count — the number of hops, and for the refusal paths
 * zero — so a change that let a lookup slip out to a provider would fail here
 * rather than appear on an invoice. The one case with no provider to count is
 * the inactive one, where the provider IS `null`: there is no object a call
 * could reach, and the slice has no fallback that could construct one.
 *
 * Plates are generated per run, because `plate_lookup.plate` is unique and two
 * uncommitted transactions inserting the same plate block each other until one
 * rolls back.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (recorded at the #102 migration)
 *   1. The ledger was read through a fake-only handle (`store.calls`). It is
 *      read here from `plate_lookup_call` itself.
 *   2. "Writes no cache for a mock result" passed for the wrong reason on an
 *      empty map. On Postgres it is a real `findUnique` returning no row, and
 *      the following credentialed lookup then proves the absence mattered.
 *   3. `fields: null` for a stored miss was a stored JS `null`. The slice maps
 *      it through `Prisma.DbNull` and back, because the column is `Json?`.
 *
 * Spec: cache on resolved/miss; failure not stored; mock neither cached nor
 * ledgered; retry of a stored miss calls the provider; an exhausted balance is
 * not a miss.
 *
 * Axes
 *   A1 cache — empty / resolved / miss / failure-not-stored
 *   A2 retry — omitted / true on a miss / true on a resolution
 *   A3 source — provider billed / mock / failed
 *   A4 plate — valid / malformed
 *
 * Outputs: O-found; O-not_found cached; O-failed; O-422; O-unavailable;
 *   O-ledger contents; O-provider call count
 *
 * Decision map (lookup-plate/index.ts, `lookupPlate`)
 *   D1 `parsePlate` null      T: malformed it; F: valid its
 *   D2 `!provider`            T: unavailable it; F: provider its
 *   D3 cache hit && !retry    T: repeat-resolved / repeat-miss its; F: miss-retry it
 *   D4 retry && stored miss   T: miss-retry it; F: resolution still served cached
 *   D5 mock                   T: mock-no-ledger it; F: billed its
 *   D6 failed                 T: exhausted / provider_error its; F: found/miss its
 *
 * Out of scope: the cache-and-ledger query contract
 *   (lookup-plate.cache.integration.test.ts); the HTTP surface
 *   (lookup-plate.integration.test.ts, and apps/api for the auth hook);
 *   `parsePlate`'s own classes (kernel/clients/placas/plate.test.ts).
 */
import { expect, it } from "vitest";
import {
  failedLookup,
  foundOrNotFound,
  type LookupResult,
  type PlateProvider,
} from "../../../../kernel/clients/placas/index.js";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createDb } from "../../../../kernel/index.js";
import { lookupPlate } from "../index.js";

const lookedUpAt = new Date("2026-09-05T15:00:00.000Z");

const db = () => prisma as PrismaClient;
const dbOn = (tx: DbClient) => createDb(tx, runInTransactionOnTx(tx));

/** A valid old-format plate (`[A-Z]{3}\d{4}`) unique to this run. */
function uniquePlate(): string {
  const letters = Array.from(
    { length: 3 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${letters}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

/** The same plate as an attendant might type it: lower case, with punctuation. */
function asTyped(plate: string): string {
  return `${plate.slice(0, 3)}-${plate.slice(3)}`.toLowerCase();
}

/**
 * A local provider that records every plate it is asked for.
 *
 * @param impl - What to answer; called once per lookup.
 * @returns A {@link PlateProvider} whose `calls` array is the spend evidence.
 */
function providerWith(impl: (plate: string) => LookupResult): PlateProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test",
    calls,
    async lookup(plate) {
      calls.push(plate);
      return impl(plate);
    },
  };
}

/** The ledger rows for a plate, oldest first, with ISO instants. */
async function listCalls(tx: DbClient, plate: string) {
  const rows = await tx.plateLookupCall.findMany({ where: { plate }, orderBy: { billedAt: "asc" } });
  return rows.map((row) => ({
    plate: row.plate,
    provider: row.provider,
    outcome: row.outcome,
    unitId: row.unitId,
    billedAt: row.billedAt.toISOString(),
  }));
}

/** The provider name of each billed hop for a plate, oldest first. */
async function hops(tx: DbClient, plate: string): Promise<string[]> {
  return (await listCalls(tx, plate)).map((row) => row.provider);
}

/** The cache row for a plate, as stored. */
function cacheRow(tx: DbClient, plate: string) {
  return tx.plateLookup.findUnique({ where: { plate } });
}

describeWithDatabase("lookupPlate", () => {
  it("rejects a malformed plate without calling the provider", () =>
    withTestTransaction(db(), async (tx) => {
      const provider = providerWith(() =>
        foundOrNotFound({ make: "VW" }, { source: "provider", provider: "p", billed: true }),
      );
      // A delta, not a total: the malformed input never becomes a plate to
      // scope a count by, so the ledger is measured before and after.
      const before = await tx.plateLookupCall.count();

      const outcome = await lookupPlate(dbOn(tx), { plate: "ZZZZZZZ" }, { plateProvider: provider });

      expect(outcome).toEqual({ statusCode: 422, body: { code: "invalid_plate" } });
      expect(provider.calls).toEqual([]);
      expect(await tx.plateLookupCall.count()).toBe(before);
    }));

  it("returns unavailable when no provider is configured", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();

      const outcome = await lookupPlate(dbOn(tx), { plate }, { plateProvider: null });

      expect(outcome).toEqual({ statusCode: 200, body: { status: "unavailable" } });
      expect(await cacheRow(tx, plate)).toBeNull();
    }));

  it("returns found fields and records a billed hop", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider = providerWith(() =>
        foundOrNotFound(
          { make: "VW", model: "GOL" },
          { source: "provider", provider: "agregados-propria", billed: true },
        ),
      );

      const outcome = await lookupPlate(
        dbOn(tx),
        { plate: asTyped(plate), unitId: "unit-1" },
        { plateProvider: provider, now: () => lookedUpAt },
      );

      expect(outcome.statusCode).toBe(200);
      expect(outcome.body).toMatchObject({
        status: "found",
        cached: false,
        fields: { make: "VW", model: "GOL" },
      });
      // Normalized before the provider saw it, so punctuation never becomes a
      // second billed plate.
      expect(provider.calls).toEqual([plate]);
      expect(await listCalls(tx, plate)).toEqual([
        {
          plate,
          provider: "agregados-propria",
          outcome: "found",
          unitId: "unit-1",
          billedAt: lookedUpAt.toISOString(),
        },
      ]);
    }));

  it("serves a stored resolution without calling the provider", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider = providerWith(() =>
        foundOrNotFound(
          { make: "VW" },
          { source: "provider", provider: "agregados-propria", billed: true },
        ),
      );
      const ports = { plateProvider: provider, now: () => lookedUpAt };
      await lookupPlate(dbOn(tx), { plate }, ports);

      const repeat = await lookupPlate(dbOn(tx), { plate: asTyped(plate) }, ports);

      expect(repeat.body).toMatchObject({ status: "found", cached: true, fields: { make: "VW" } });
      expect(provider.calls).toHaveLength(1);
      expect(await hops(tx, plate)).toEqual(["agregados-propria"]);
    }));

  it("serves a stored miss without calling the provider", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider = providerWith(() =>
        foundOrNotFound({}, { source: "provider", provider: "placas", billed: true }),
      );
      await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider, now: () => lookedUpAt });
      // The miss is stored with a null `fields`, which the slice maps through
      // Prisma.DbNull and reads back as null for the hit below to work.
      expect(await cacheRow(tx, plate)).toMatchObject({ outcome: "miss", fields: null });

      const repeat = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });

      expect(repeat.body).toMatchObject({
        status: "not_found",
        cached: true,
        recordedOutcome: "miss",
        lookedUpAt: lookedUpAt.toISOString(),
      });
      expect(provider.calls).toHaveLength(1);
    }));

  it("does not cache a failure so the next lookup reaches a provider", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      let fail = true;
      const provider = providerWith(() =>
        fail
          ? failedLookup("agregados-propria", "exhausted_balance")
          : foundOrNotFound(
              { make: "VW" },
              { source: "provider", provider: "agregados-propria", billed: true },
            ),
      );

      const first = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });
      fail = false;
      const second = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });

      expect(first.body).toEqual({ status: "failed", reason: "exhausted_balance" });
      expect(second.body).toMatchObject({ status: "found", cached: false });
      expect(provider.calls).toHaveLength(2);
      // The failed hop is billed and ledgered; only the cache row is withheld.
      expect(await hops(tx, plate)).toEqual(["agregados-propria"]);
    }));

  it("records two ledger entries when a miss reaches both providers", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider: PlateProvider & { calls: string[] } = {
        name: "placas",
        calls: [],
        async lookup(asked) {
          provider.calls.push(asked);
          return {
            status: "not_found",
            source: "provider",
            provider: "placas",
            billed: true,
            billedCalls: [
              { provider: "agregados-propria", outcome: "not_found" },
              { provider: "api-placas", outcome: "not_found" },
            ],
          };
        },
      };

      await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider, now: () => lookedUpAt });

      expect(provider.calls).toHaveLength(1);
      // Both hops of one lookup carry the same `billedAt`, so the sort key
      // cannot order them; assert the set.
      expect((await hops(tx, plate)).sort()).toEqual(["agregados-propria", "api-placas"]);
    }));

  it("writes no ledger and no cache for a mock result", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider = providerWith(() =>
        foundOrNotFound({ make: "VW" }, { source: "mock", provider: "mock", billed: false }),
      );

      const first = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });

      expect(first.body).toMatchObject({ status: "found", source: "mock", fields: { make: "VW" } });
      expect(await hops(tx, plate)).toEqual([]);
      expect(await cacheRow(tx, plate)).toBeNull();

      // Nothing was cached, so a credentialed provider is reached rather than
      // served the mock's answer — which is what the missing row has to mean.
      const credentialed = providerWith(() =>
        foundOrNotFound(
          { make: "FIAT" },
          { source: "provider", provider: "agregados-propria", billed: true },
        ),
      );
      const second = await lookupPlate(dbOn(tx), { plate }, { plateProvider: credentialed });

      expect(second.body).toMatchObject({
        status: "found",
        source: "provider",
        fields: { make: "FIAT" },
      });
      expect(credentialed.calls).toEqual([plate]);
    }));

  it("retries a stored miss and replaces it on success", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      let miss = true;
      const provider = providerWith(() =>
        miss
          ? foundOrNotFound({}, { source: "provider", provider: "placas", billed: true })
          : foundOrNotFound(
              { make: "VW" },
              { source: "provider", provider: "agregados-propria", billed: true },
            ),
      );

      await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider, now: () => lookedUpAt });
      const cached = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });
      miss = false;
      const retried = await lookupPlate(
        dbOn(tx),
        { plate, retry: true },
        { plateProvider: provider, now: () => new Date("2026-09-06T12:00:00.000Z") },
      );

      expect(cached.body).toMatchObject({ status: "not_found", cached: true });
      expect(retried.body).toMatchObject({
        status: "found",
        cached: false,
        fields: { make: "VW" },
      });
      expect(provider.calls).toHaveLength(2);
      // The update arm of the slice's upsert: one row, now resolved.
      expect(await cacheRow(tx, plate)).toMatchObject({
        outcome: "resolved",
        provider: "agregados-propria",
      });
      expect(await tx.plateLookup.count({ where: { plate } })).toBe(1);
    }));

  it("writes no ledger for an exhausted balance", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const provider = providerWith(() => failedLookup("p", "exhausted_balance"));

      const outcome = await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider });

      expect(outcome.body).toEqual({ status: "failed", reason: "exhausted_balance" });
      expect(provider.calls).toEqual([plate]);
      expect(await hops(tx, plate)).toEqual([]);
      expect(await cacheRow(tx, plate)).toBeNull();
    }));

  it("distinguishes not_found, provider_error and exhausted_balance", () =>
    withTestTransaction(db(), async (tx) => {
      const [missed, errored, exhausted] = [uniquePlate(), uniquePlate(), uniquePlate()];
      const missing = providerWith(() =>
        foundOrNotFound({}, { source: "provider", provider: "p", billed: true }),
      );
      const erroring = providerWith(() => failedLookup("p", "provider_error"));
      const broke = providerWith(() => failedLookup("p", "exhausted_balance"));

      const miss = await lookupPlate(dbOn(tx), { plate: missed }, { plateProvider: missing });
      const error = await lookupPlate(dbOn(tx), { plate: errored }, { plateProvider: erroring });
      const balance = await lookupPlate(dbOn(tx), { plate: exhausted }, { plateProvider: broke });

      expect(miss.body).toMatchObject({ status: "not_found" });
      expect(error.body).toEqual({ status: "failed", reason: "provider_error" });
      expect(balance.body).toEqual({ status: "failed", reason: "exhausted_balance" });
      // Each provider was asked exactly once, for its own plate.
      expect([missing.calls, erroring.calls, broke.calls]).toEqual([[missed], [errored], [exhausted]]);
      // Only the miss is cached; neither failure is.
      expect(await cacheRow(tx, missed)).toMatchObject({ outcome: "miss" });
      expect(await cacheRow(tx, errored)).toBeNull();
      expect(await cacheRow(tx, exhausted)).toBeNull();
    }));

  it("strips owner keys before persisting raw payload", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      const raw = {
        data: { marca: "VW", documento_faturado: "000", tipo_faturado: "J", uf_faturado: "SP" },
      };
      const provider = providerWith(() =>
        foundOrNotFound({ make: "VW" }, { source: "provider", provider: "p", billed: true }, raw),
      );

      await lookupPlate(dbOn(tx), { plate }, { plateProvider: provider, now: () => lookedUpAt });

      expect(provider.calls).toEqual([plate]);
      // The column itself is clean, not just a mapper's output.
      const row = await tx.plateLookup.findUniqueOrThrow({ where: { plate } });
      expect(JSON.stringify(row.rawPayload)).not.toContain("documento_faturado");
      expect(row.rawPayload).toMatchObject({ data: { marca: "VW" } });
    }));
});
