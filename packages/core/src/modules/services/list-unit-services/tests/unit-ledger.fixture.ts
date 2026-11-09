/**
 * The ledger the unit-listing tests read: one unit, two customers, two vehicles,
 * five services and three vehicle returns, written into the test transaction.
 *
 * Moved from `apps/api/src/services/unit-listing.test.ts` (adopt-modular-vertical-
 * slices 3C), unchanged but for what `seedLedger` hands back: `store.listUnitPage`
 * is now the `list-unit-services` slice's `listUnitServices` over the test
 * transaction, so each moved assertion reads exactly as it did. See
 * `unit-listing-filters.integration.test.ts` for the test design.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { runInTransactionOnTx, seedUnit, withTestTransaction } from "@select-lub/core/testing";
import { it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import type { UnitServiceQuery } from "../../contracts/http.js";
import { listUnitServices } from "../index.js";

export type Seed = {
  id: string;
  customerKey: "cus-ana" | "cus-bruno";
  vehicleKey: "veh-a" | "veh-b" | null;
  performedAt: string | null;
  omieId: string;
};

/** Five services: three dated, two undated, spread over two vehicles and one with none. */
export const SEEDS: Seed[] = [
  { id: "s-jun", customerKey: "cus-ana", vehicleKey: "veh-a", performedAt: "2026-06-10T12:00:00.000Z", omieId: "OS-900" },
  { id: "s-mar", customerKey: "cus-ana", vehicleKey: "veh-a", performedAt: "2026-03-12T12:00:00.000Z", omieId: "OS-800" },
  { id: "s-jan", customerKey: "cus-bruno", vehicleKey: "veh-b", performedAt: "2026-01-05T12:00:00.000Z", omieId: "OS-700" },
  { id: "s-undated-a", customerKey: "cus-bruno", vehicleKey: "veh-b", performedAt: null, omieId: "OS-600" },
  { id: "s-undated-b", customerKey: "cus-ana", vehicleKey: null, performedAt: null, omieId: "OS-500" },
];

/**
 * A calendar day relative to today, `YYYY-MM-DD`.
 *
 * Offsets of five days rather than one on purpose: the filter's window is built
 * in America/Sao_Paulo and this helper counts in UTC, so the two can disagree by
 * a day for the three hours after UTC midnight. Five days survives that; one
 * would flip "vencido" into "aproximando" on a nightly run.
 */
function dayOffset(days: number) {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/**
 * Writes the whole ledger — unit, two customers, two vehicles, five services and
 * their vehicle returns — into the test transaction.
 *
 * `s-jun` is veh-a's most recent service and carries the live overdue return;
 * `s-mar` is the SAME vehicle's older service, whose return was superseded. That
 * pair is the case the spec names: an old oil change on an overdue car must not
 * appear alongside the current one.
 *
 * @param tx - The test transaction.
 * @param options - `junReturnStatus` overrides the status of `s-jun`'s return,
 *   for the archived case.
 * @returns The unit's id and `store.listUnitPage`, the slice under test.
 */
export async function seedLedger(
  tx: DbClient,
  options: { junReturnStatus?: string } = {},
) {
  const unit = await seedUnit(tx);
  const customerIds: Record<Seed["customerKey"], string> = {
    "cus-ana": "",
    "cus-bruno": "",
  };
  for (const [key, name] of [
    ["cus-ana", "Ana Beatriz"],
    ["cus-bruno", "Bruno Salles"],
  ] as const) {
    const row = await tx.customer.create({
      data: { name, unitId: unit.id, origin: "omie", status: "active" },
      select: { id: true },
    });
    customerIds[key] = row.id;
  }

  const vehicleIds: Record<"veh-a" | "veh-b", string> = { "veh-a": "", "veh-b": "" };
  for (const [key, data] of [
    ["veh-a", { customerKey: "cus-ana", plate: "ABC-1D23", make: "Toyota", model: "Corolla", year: 2019 }],
    ["veh-b", { customerKey: "cus-bruno", plate: "XYZ-4B56", make: "Honda", model: "Civic", year: 2021 }],
  ] as const) {
    const row = await tx.vehicle.create({
      data: {
        customerId: customerIds[data.customerKey],
        plate: data.plate,
        make: data.make,
        model: data.model,
        year: data.year,
        origin: "omie",
      },
      select: { id: true },
    });
    vehicleIds[key] = row.id;
  }

  for (const seed of SEEDS) {
    await tx.service.create({
      data: {
        id: seed.id,
        unitId: unit.id,
        customerId: customerIds[seed.customerKey],
        vehicleId: seed.vehicleKey === null ? null : vehicleIds[seed.vehicleKey],
        performedAt: seed.performedAt === null ? null : new Date(seed.performedAt),
        omieId: seed.omieId,
        origin: "omie",
      },
    });
  }

  for (const row of [
    { sourceServiceId: "s-jun", vehicleKey: "veh-a", status: options.junReturnStatus ?? "OPEN", returnDate: dayOffset(-5) },
    { sourceServiceId: "s-jan", vehicleKey: "veh-b", status: "OPEN", returnDate: dayOffset(5) },
    { sourceServiceId: "s-mar", vehicleKey: "veh-a", status: "SUPERSEDED", returnDate: dayOffset(-200) },
  ] as const) {
    await tx.vehicleReturn.create({
      data: {
        sourceServiceId: row.sourceServiceId,
        vehicleId: vehicleIds[row.vehicleKey],
        status: row.status,
        returnDate: new Date(`${row.returnDate}T00:00:00.000Z`),
      },
    });
  }

  // The old store's method name, so every moved assertion reads as it did: the
  // slice's plain function over the test transaction, under `module_services`.
  const db = createDb(tx, runInTransactionOnTx(tx));
  return {
    unitId: unit.id,
    store: {
      listUnitPage: (unitId: string, query: UnitServiceQuery) =>
        listUnitServices(db, unitId, query),
    },
  };
}

/**
 * `it` whose body runs inside a test transaction that always rolls back.
 *
 * @param name - Test name, as for `it`.
 * @param fn - Test body; receives the transaction client the store is built on.
 */
export function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

