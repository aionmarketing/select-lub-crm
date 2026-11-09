/**
 * Test design (testing-strategy) — scheduling / unarchive-vehicle-return
 *
 * Module role: the state read runs under `module_scheduling`; the write goes
 * through `services/contracts/archive-vehicle-return.ts` under
 * `module_services`, which owns `vehicle_return`.
 *
 * New file. The old unarchive assertions sat inside a multi-route case that
 * moved, unchanged, to `apps/api/test/scheduling.integration.test.ts`.
 *
 * SUT: `POST /vehicle-returns/:returnId/unarchive`, through `buildSliceApp` with
 *   this slice's route only, inside one rolling-back transaction per test.
 *
 * Oracle: vehicle-returns — archiving is reversible; unarchiving puts the return
 *   back on the Follow-up queue.
 *
 * Sampled-cell
 *   ARCHIVED return          | 200 {} OPEN, archive stamps cleared | left archived
 *   OPEN return              | 409 return_not_archived              | 200 on a no-op
 *   vehicle already has OPEN | 409 return_not_archived, stays ARCHIVED | 500 on the P2002
 *   another loja's return    | 404, row unchanged                   | unarchiving across lojas
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

/** A return in a fresh loja with the given status, and that loja's attendant. */
async function seedReturn(tx: DbClient, status: "OPEN" | "ARCHIVED") {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" }, select: { id: true } });
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: unit.id, origin: "crm", performedAt: new Date() },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: {
      vehicleId: vehicle.id,
      sourceServiceId: service.id,
      returnDate: new Date("2099-01-01T00:00:00.000Z"),
      status,
      ...(status === "ARCHIVED" ? { archivedAt: new Date(), archivedByUserId: user.id } : {}),
    },
    select: { id: true },
  });
  return { unitId: unit.id, userId: user.id, returnId: vehicleReturn.id };
}

async function unarchive(tx: DbClient, caller: { unitId: string; userId: string }, returnId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "scheduling", "unarchive-vehicle-return", route),
    caller: { userId: caller.userId, unitId: caller.unitId },
  });
  try {
    return await app.inject({ method: "POST", url: `/vehicle-returns/${returnId}/unarchive` });
  } finally {
    await app.close();
  }
}

function returnOf(tx: DbClient, returnId: string) {
  return tx.vehicleReturn.findUniqueOrThrow({
    where: { id: returnId },
    select: { status: true, archivedAt: true, archivedByUserId: true },
  });
}

describeWithDatabase("POST /vehicle-returns/:returnId/unarchive", () => {
  it("puts an archived return back on the queue and clears who archived it", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await seedReturn(tx, "ARCHIVED");

      const response = await unarchive(tx, r, r.returnId);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({});
      const row = await returnOf(tx, r.returnId);
      expect(row.status).toBe("OPEN");
      expect(row.archivedAt).toBeNull();
      expect(row.archivedByUserId).toBeNull();
    }));

  it("refuses a return that is not archived", () =>
    withTestTransaction(db(), async (tx) => {
      const r = await seedReturn(tx, "OPEN");

      const response = await unarchive(tx, r, r.returnId);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "return_not_archived" });
    }));

  it("refuses, with the same 409, a return whose vehicle already has an open one", () =>
    withTestTransaction(db(), async (tx) => {
      // One of the ARCHIVED + OPEN pairs earlier imports left on one service
      // (owner rulings, 2026-09-25): a second OPEN row is what the
      // one-open-return index refuses, and the P2002 is answered as a refusal,
      // not a 500.
      const r = await seedReturn(tx, "ARCHIVED");
      const archived = await tx.vehicleReturn.findUniqueOrThrow({ where: { id: r.returnId } });
      await tx.vehicleReturn.create({
        data: {
          vehicleId: archived.vehicleId,
          sourceServiceId: archived.sourceServiceId,
          returnDate: archived.returnDate,
          status: "OPEN",
        },
      });

      const response = await unarchive(tx, r, r.returnId);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "return_not_archived" });
      expect((await returnOf(tx, r.returnId)).status).toBe("ARCHIVED");
    }));

  it("hides another loja's return behind a 404 and leaves it archived", () =>
    withTestTransaction(db(), async (tx) => {
      const mine = await seedReturn(tx, "OPEN");
      const theirs = await seedReturn(tx, "ARCHIVED");

      const response = await unarchive(tx, mine, theirs.returnId);

      expect(response.statusCode).toBe(404);
      expect((await returnOf(tx, theirs.returnId)).status).toBe("ARCHIVED");
    }));
});
