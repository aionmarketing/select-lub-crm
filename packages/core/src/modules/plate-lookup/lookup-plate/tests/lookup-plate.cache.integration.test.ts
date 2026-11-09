/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/plate-lookup/store.test.ts (wave 2, stream 2A of
 * adopt-modular-vertical-slices), plus the new `readCachedPlateFields`
 * contract. Module role: the slice's queries ran under `module_plate_lookup`;
 * the contract ran under `module_quotes`, the role of the module that consumes
 * it.
 *
 * WHY THE STORE CASES ARE NOW DRIVEN THROUGH LOOKUPS. The old file called the
 * adapter's `saveLookup` / `recordCall` / `getByPlate` / `listCalls` directly.
 * In the slice those queries are private, and a slice test may import only the
 * slice's entry point (design D9: a test that only checked a store interface is
 * folded into the slice test that exercises the same query). So each case now
 * drives the same queries through `lookupPlate`, and reads the tables back
 * through `tx`. Every assertion the old file made is still made, against the
 * same rows.
 *
 * NO TEST HERE MAY REACH A REAL PROVIDER. Every provider is a local counting
 * object, and each case asserts its call count.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (recorded at the #102 migration)
 *   1. The ledger's order was insertion order on the fake. Postgres orders by
 *      `billed_at`, and both hops of one lookup share one `billed_at`, so the
 *      shared-instant hops are asserted as a set, and a separate case with
 *      distinct instants pins the order that key does promise.
 *   2. `fields: null` round-tripped for free on the fake. The slice maps a miss
 *      through `Prisma.DbNull` because the column is `Json?`.
 *   3. The miss-then-resolved replacement was a `Map.set`; it is now the update
 *      arm of an upsert on a unique index.
 *
 * Contract (`contracts/cached-plate.ts`): a resolution returns its fields; a
 * miss, a plate never cached, and input that is not a plate return `null`; and
 * a legacy `"found"` outcome — what the demo seed wrote before #132 — still
 * counts as a resolution (W2-C8).
 *
 * Axes
 *   A1 cache — empty / stored miss / miss replaced by a resolution
 *   A2 ledger — 2 hops sharing one `billed_at` / 2 hops with distinct instants
 *   A3 contract row — resolved / "found" / miss / absent / not a plate
 *
 * Out of scope: the lookup decisions (lookup-plate.decisions.integration.test.ts);
 *   the HTTP surface (lookup-plate.integration.test.ts).
 */
import { expect, it } from "vitest";
import { foundOrNotFound, type LookupResult, type PlateProvider } from "../../../../kernel/clients/placas/index.js";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createDb } from "../../../../kernel/index.js";
import { readCachedPlateFields } from "../../contracts/cached-plate.js";
import { lookupPlate } from "../index.js";

const billedAt = new Date("2026-09-05T15:00:00.000Z");

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

/** A local provider that answers `result` and counts the plates it was asked for. */
function answering(result: LookupResult): PlateProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test",
    calls,
    async lookup(plate) {
      calls.push(plate);
      return result;
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

describeWithDatabase("lookup-plate cache and ledger", () => {
  it("satisfies the cache and ledger contract", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const plate = uniquePlate();
      expect(await tx.plateLookup.findUnique({ where: { plate } })).toBeNull();

      // A provider miss that bills nothing: cached, not ledgered.
      const miss = answering(
        foundOrNotFound({}, { source: "provider", provider: "placas", billed: false }),
      );
      await lookupPlate(dbOn(tx), { plate }, { plateProvider: miss, now: () => billedAt });
      expect(await tx.plateLookup.findUnique({ where: { plate } })).toMatchObject({
        plate,
        outcome: "miss",
        provider: "placas",
        fields: null,
      });

      // The retry resolves through a two-hop cascade: the first provider misses,
      // the second finds. One lookup, so both hops share one `billed_at`.
      const cascade = answering({
        status: "found",
        source: "provider",
        provider: "api-placas",
        billed: true,
        billedCalls: [
          { provider: "agregados-propria", outcome: "not_found" },
          { provider: "api-placas", outcome: "found" },
        ],
        fields: { make: "VW", model: "GOL" },
        raw: { data: { marca: "VW" } },
      });
      await lookupPlate(
        dbOn(tx),
        { plate, retry: true, unitId: unit.id },
        { plateProvider: cascade, now: () => billedAt },
      );
      expect(await tx.plateLookup.findUnique({ where: { plate } })).toMatchObject({
        outcome: "resolved",
        fields: { make: "VW", model: "GOL" },
      });

      expect([miss.calls, cascade.calls]).toEqual([[plate], [plate]]);
      // A set: both hops share `billed_at`, so `ORDER BY billed_at` cannot
      // separate them.
      const calls = await listCalls(tx, plate);
      expect(calls).toHaveLength(2);
      const iso = billedAt.toISOString();
      expect([...calls].sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
        { plate, provider: "agregados-propria", outcome: "not_found", unitId: unit.id, billedAt: iso },
        { plate, provider: "api-placas", outcome: "found", unitId: unit.id, billedAt: iso },
      ]);
    }));

  it("lists ledger hops oldest first when their billed instants differ", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const plate = uniquePlate();
      const later = new Date("2026-09-05T16:00:00.000Z");
      const first = answering(
        foundOrNotFound({}, { source: "provider", provider: "api-placas", billed: true }),
      );
      const second = answering(
        foundOrNotFound({ make: "VW" }, { source: "provider", provider: "agregados-propria", billed: true }),
      );

      // Written newest first — the later hop, then a retry at an earlier clock —
      // so insertion order and `billed_at` order disagree.
      await lookupPlate(dbOn(tx), { plate, unitId: unit.id }, { plateProvider: first, now: () => later });
      await lookupPlate(
        dbOn(tx),
        { plate, retry: true, unitId: unit.id },
        { plateProvider: second, now: () => billedAt },
      );

      expect([first.calls, second.calls]).toEqual([[plate], [plate]]);
      expect((await listCalls(tx, plate)).map((row) => row.provider)).toEqual([
        "agregados-propria",
        "api-placas",
      ]);
    }));

  it("records the hop against the unit that will be billed for it", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const plate = uniquePlate();
      const provider = answering(
        foundOrNotFound({ make: "VW" }, { source: "provider", provider: "agregados-propria", billed: true }),
      );

      await lookupPlate(dbOn(tx), { plate, unitId: unit.id }, { plateProvider: provider, now: () => billedAt });

      expect(provider.calls).toEqual([plate]);
      const rows = await tx.plateLookupCall.findMany({ where: { plate } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.unitId).toBe(unit.id);
    }));
});

describeWithDatabase("readCachedPlateFields, read by quotes", () => {
  /** The contract as `quotes` calls it: inside its own role's transaction. */
  const asQuotes = (tx: DbClient, plate: string) =>
    dbOn(tx).tx("quotes", (quotesTx) => readCachedPlateFields(quotesTx, plate));

  /** A cache row written directly, as the slice or the demo seed would leave it. */
  async function cache(
    tx: DbClient,
    plate: string,
    outcome: string,
    fields: { make?: string; displacementCc?: number; fuel?: string } | null,
  ) {
    await tx.plateLookup.create({
      data: {
        plate,
        outcome,
        provider: "agregados-propria",
        fields: fields ?? undefined,
        lookedUpAt: billedAt,
      },
    });
  }

  it("returns the fields of a resolved row, under the quotes role", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      await cache(tx, plate, "resolved", { make: "VW", displacementCc: 1598, fuel: "flex" });

      // Under `module_quotes`: the `readableBy: "*"` grant is what admits this
      // SELECT, so a missing grant would be a permission error here, not a null.
      expect(await asQuotes(tx, plate)).toEqual({ make: "VW", displacementCc: 1598, fuel: "flex" });
    }));

  it("normalizes the plate it is handed", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      await cache(tx, plate, "resolved", { make: "VW" });
      const typed = `${plate.slice(0, 3)}-${plate.slice(3)}`.toLowerCase();

      expect(await asQuotes(tx, typed)).toEqual({ make: "VW" });
    }));

  it("treats a legacy \"found\" outcome as a resolution", () =>
    withTestTransaction(db(), async (tx) => {
      const plate = uniquePlate();
      // The demo seed wrote "found" until #132, and a database seeded before
      // that and not re-seeded still holds such rows. The production writer
      // never writes it. Tightening the read to "resolved" would drop them (W2-C8).
      await cache(tx, plate, "found", { fuel: "gasolina" });

      expect(await asQuotes(tx, plate)).toEqual({ fuel: "gasolina" });
    }));

  it("returns null for a stored miss, a plate never cached, and input that is not a plate", () =>
    withTestTransaction(db(), async (tx) => {
      const missed = uniquePlate();
      await cache(tx, missed, "miss", null);
      // Positive control: a resolved row beside it does come back.
      const resolved = uniquePlate();
      await cache(tx, resolved, "resolved", { make: "FIAT" });
      expect(await asQuotes(tx, resolved)).toEqual({ make: "FIAT" });

      expect(await asQuotes(tx, missed)).toBeNull();
      expect(await asQuotes(tx, uniquePlate())).toBeNull();
      expect(await asQuotes(tx, "not a plate")).toBeNull();
    }));
});
