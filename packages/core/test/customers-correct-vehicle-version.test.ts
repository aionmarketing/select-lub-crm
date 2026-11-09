/**
 * Test design (testing-strategy) — the quote's engine pick corrects the version (task 5.13)
 *
 * SUT: `versionWithEngine` (pure) and `correctVehicleVersion` (the customers contract the quotes
 *   slice calls) on the rolling-back transaction, under the `customers` role, with a fake Omie.
 *
 * Oracle: `customer-vehicles` "The quote's engine pick corrects the version" (owner 2026-09-27 and
 *   2026-09-30); prefill reads only `PLACA`-marked keys as off limits (`prefill/internal/reads.ts`),
 *   so a key no longer marked is one it may suggest again.
 *
 * Oracle for the engine part: the orchestrator's ruling of 2026-10-01 (review of #197) — the text
 *   before the displacement token is the trim, everything from it to the end is replaced.
 *
 * Cells (input | expected | the bug it would miss)
 *   "XEi" + "1.8 Dual VVT-i"            | "XEi 1.8 Dual VVT-i"        | the trim dropped (owner)
 *   "XEi 1.0" + "1.6"                   | "XEi 1.6"                   | "XEi 1.0 1.6" (owner)
 *   "XEi 1.8 Dual VVT-i" + "2.0 Dynamic Force" | "XEi 2.0 Dynamic Force" | the old engine's words left (owner)
 *   "Comfortline 1.0 TSI" + "1.4 TSI"   | "Comfortline 1.4 TSI"       | "… 1.4 TSI TSI"
 *   "XEi 1.0L" + "1.6"                  | "XEi 1.6"                   | "XEi 1.0L 1.6"
 *   "1.0 FLEX 12V 4P" + "1.6"           | "1.6"                       | the old engine's words left
 *   "XEi 1.8 Dual VVT-i" + its engine   | unchanged                   | the engine appended twice
 *   a PLACA version                     | written, origin CRM, not plate-sourced | a plate mark that blocks prefill for good
 *   a sibling of the identity           | untouched                   | every car of the model rewritten
 *   a version past the limit            | version_too_long, nothing written | an overlong field
 *   another unit's vehicle              | not_found, nothing written  | a foreign vehicle edited
 *   computed from a version since changed | version_changed, nothing written | a lost update over a rail edit
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
import { createFakeOmie } from "../src/kernel/clients/erp-mock.js";
import { createDb } from "../src/kernel/db.js";
import { createPlateOriginStore } from "../src/modules/customers/contracts/cadastro-store/plate-origin.js";
import { correctVehicleVersion, VEHICLE_VERSION_MAX_LENGTH, versionWithEngine } from "../src/modules/customers/contracts/correct-vehicle-version.js";
import { describeWithDatabase, runInTransactionOnTx, seedUnit, seedUser, withTestTransaction } from "../src/testing/index.js";

describe("versionWithEngine", () => {
  it.each([
    ["XEi", "1.8 Dual VVT-i", "XEi 1.8 Dual VVT-i"],
    ["XEi 1.0", "1.6", "XEi 1.6"],
    ["XEi 1.8 Dual VVT-i", "2.0 Dynamic Force", "XEi 2.0 Dynamic Force"],
    ["Comfortline 1.0 TSI", "1.4 TSI", "Comfortline 1.4 TSI"],
    ["XEi 1.0L", "1.6", "XEi 1.6"],
    ["1.0 FLEX 12V 4P", "1.6", "1.6"],
    ["XEi 1,0", "2.0 Dynamic Force", "XEi 2.0 Dynamic Force"],
    ["XEi 1.8 Dual VVT-i", "1.8 Dual VVT-i", "XEi 1.8 Dual VVT-i"],
    ["", "1.6", "1.6"],
  ])("corrects %j with %j to %j", (version, engine, expected) => {
    expect(versionWithEngine(version, engine)).toBe(expected);
  });
});

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

async function seed(tx: DbClient, version = "XEi") {
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const identity = { make: "Toyota", year: 2019, model: `Corolla ${randomUUID().slice(0, 6)}`, version };
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  const sibling = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  await tx.vehicleFieldSync.create({ data: { vehicleId: vehicle.id, fieldKey: "version", origin: "PLACA", localVersion: 1 } });
  const db = createDb(tx, runInTransactionOnTx(tx));
  const versionOf = async (id: string) => (await tx.vehicle.findUniqueOrThrow({ where: { id } })).version;
  return { db, unitId: unit.id, otherUnitId: other.id, userId: user.id, vehicleId: vehicle.id, siblingId: sibling.id, versionOf };
}

describeWithDatabase("correctVehicleVersion", () => {
  itInTx("keeps the trim, makes a PLACA origin CRM, and leaves another vehicle of the identity alone", async (tx) => {
    const ctx = await seed(tx);

    const result = await correctVehicleVersion(ctx.db, createFakeOmie(), { vehicleId: ctx.vehicleId, unitId: ctx.unitId, fromVersion: "XEi", version: versionWithEngine("XEi", "1.8 Dual VVT-i"), actorId: ctx.userId });

    expect(result).toMatchObject({ status: "ok", vehicle: { version: "XEi 1.8 Dual VVT-i", plateSourcedKeys: [] } });
    expect(await ctx.versionOf(ctx.vehicleId)).toBe("XEi 1.8 Dual VVT-i");
    const origins = createPlateOriginStore(ctx.db);
    expect(await origins.getFieldOrigin(ctx.vehicleId, "version")).toMatchObject({ origin: "CRM", localVersion: 2 });
    // No longer plate-sourced, so the assistive prefill may suggest the version again.
    expect(await origins.listPlateSourcedKeys(ctx.vehicleId)).not.toContain("version");
    expect(await ctx.versionOf(ctx.siblingId)).toBe("XEi");
  });

  itInTx("refuses a version past the field's limit and writes nothing", async (tx) => {
    const long = "X".repeat(VEHICLE_VERSION_MAX_LENGTH - 2);
    const ctx = await seed(tx, long);

    expect(await correctVehicleVersion(ctx.db, createFakeOmie(), { vehicleId: ctx.vehicleId, unitId: ctx.unitId, fromVersion: long, version: versionWithEngine(long, "1.6") })).toEqual({ status: "version_too_long" });
    expect(await ctx.versionOf(ctx.vehicleId)).toBe(long);
  });

  itInTx("answers not_found for another unit's vehicle and writes nothing", async (tx) => {
    const ctx = await seed(tx);

    expect(await correctVehicleVersion(ctx.db, createFakeOmie(), { vehicleId: ctx.vehicleId, unitId: ctx.otherUnitId, fromVersion: "XEi", version: "XEi 1.6" })).toEqual({ status: "not_found" });
    expect(await ctx.versionOf(ctx.vehicleId)).toBe("XEi");
  });

  itInTx("writes nothing when the version changed after the correction was computed from it", async (tx) => {
    const ctx = await seed(tx);
    await tx.vehicle.update({ where: { id: ctx.vehicleId }, data: { version: "XEi 2.0 Dynamic Force" } });

    const result = await correctVehicleVersion(ctx.db, createFakeOmie(), { vehicleId: ctx.vehicleId, unitId: ctx.unitId, fromVersion: "XEi", version: "XEi 1.8 Dual VVT-i" });

    expect(result).toEqual({ status: "version_changed" });
    expect(await ctx.versionOf(ctx.vehicleId)).toBe("XEi 2.0 Dynamic Force");
    expect(await createPlateOriginStore(ctx.db).getFieldOrigin(ctx.vehicleId, "version")).toMatchObject({ origin: "PLACA" });
  });
});
