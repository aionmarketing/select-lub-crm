/**
 * Test design (testing-strategy) — the attendant's fill volume (tasks 5.8, 5.9)
 *
 * SUT: `POST /vehicles/:id/oil-fill-volume` over HTTP (`app.inject`, so the body and the answer go
 *   through the route's schemas), mounted on the rolling-back transaction. Ran under module role: `quotes`. The caller is a real seeded user
 *   (the row's author is a foreign key), with a display name the quote shows.
 *
 * Oracle: the `shared-types` delta "Quote options carry what the attendant needs to resolve a dead
 *   end" (the route's answers); `oil-attendant-fill` "An attendant volume is stored per identity,
 *   with who and when" and "A stored attendant volume never becomes a source"; `oil-quote` "The
 *   attendant can type a missing fill volume"; design D24.1, F7.
 *
 * Cells (request or state | expected | the bug it would miss)
 *   another unit's / unknown vehicle   | 404 {}, nothing stored                      | a foreign vehicle confirmed
 *   incomplete identity                | 409 incomplete_identity, nothing stored     | a volume keyed by nothing
 *   0, -1, 4.255, "4,2"                | 400, nothing stored                          | a non-volume kept
 *   42 without / with confirmHighVolume| 422 high_volume / 201, 42 stored             | the dialog's warning skipped
 *   4,2 kept                           | 201 with the user's name; one row; no cache, grade source or research write | a typed volume leaking into research
 *
 * How a kept volume prices the next quote is `get-quote-options/tests/get-quote-options.dead-ends.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import { buildSliceApp, describeWithDatabase, runInTransactionOnTx, seedUnit, seedUser, withTestTransaction } from "../../../../testing/index.js";
import { identityKey } from "../../contracts/oil-research-attention.js";
import { route } from "../index.js";

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

/** A unit with two vehicles of one fresh identity, one with no version, one in another unit; the slice mounted. */
async function seed(tx: DbClient) {
  const identity = { make: "Toyota", year: 2019, model: "Corolla", version: `XEi ${randomUUID().slice(0, 8)}` };
  const unit = await seedUnit(tx);
  const other = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id], name: "Marina" });
  const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
  const outsider = await tx.customer.create({ data: { name: "Outra", unitId: other.id, origin: "manual", status: "active" }, select: { id: true } });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  const sibling = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
  const incomplete = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity, version: null }, select: { id: true } });
  const foreign = await tx.vehicle.create({ data: { customerId: outsider.id, origin: "crm", ...identity }, select: { id: true } });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (a) => registerSlice(a, "quotes", "record-oil-fill-volume", route()),
    caller: { userId: user.id, unitId: unit.id, unitIds: [unit.id] },
  });
  const post = async (body: unknown, vehicleId = vehicle.id) => {
    const res = await app.inject({ method: "POST", url: `/vehicles/${vehicleId}/oil-fill-volume`, payload: body as object });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const stored = () => tx.oilAttendantFill.findMany({ where: { identityKey: identityKey(identity)! }, orderBy: { recordedAt: "asc" } });
  return { identity, user, vehicleId: vehicle.id, siblingId: sibling.id, incompleteId: incomplete.id, foreignId: foreign.id, post, stored };
}

describeWithDatabase("POST /vehicles/:id/oil-fill-volume", () => {
  itInTx("answers 404 for another unit's vehicle and an unknown id, storing nothing", async (tx) => {
    const ctx = await seed(tx);

    expect(await ctx.post({ liters: 4.2 }, ctx.foreignId)).toEqual({ status: 404, body: {} });
    expect(await ctx.post({ liters: 4.2 }, randomUUID())).toEqual({ status: 404, body: {} });
    expect(await ctx.stored()).toEqual([]);
  });

  itInTx("answers 409 incomplete_identity for a vehicle with no version, storing nothing", async (tx) => {
    const ctx = await seed(tx);

    expect(await ctx.post({ liters: 4.2 }, ctx.incompleteId)).toEqual({ status: 409, body: { reason: "incomplete_identity" } });
    expect(await tx.oilAttendantFill.count({ where: { make: "Toyota", model: "Corolla", year: 2019 } })).toBe(0);
  });

  it.each([0, -1, 4.255, "4,2"])("refuses %s as a volume and stores nothing", (liters) =>
    withTestTransaction(prisma as PrismaClient, async (tx) => {
      const ctx = await seed(tx);

      expect((await ctx.post({ liters })).status).toBe(400);
      expect(await ctx.stored()).toEqual([]);
    }),
  );

  itInTx("answers the high-volume warning for 42 L without its confirmation, and stores 42 L with it", async (tx) => {
    const ctx = await seed(tx);

    expect(await ctx.post({ liters: 42 })).toEqual({ status: 422, body: { warning: "high_volume" } });
    expect(await ctx.stored()).toEqual([]);

    const confirmed = await ctx.post({ liters: 42, confirmHighVolume: true });
    expect(confirmed).toMatchObject({ status: 201, body: { liters: 42, recordedBy: "Marina" } });
    expect((await ctx.stored()).map((row) => row.liters.toNumber())).toEqual([42]);
  });

  itInTx("stores 4,2 L with who and when, and writes no cache row, grade source or research row", async (tx) => {
    const ctx = await seed(tx);
    const before = { motul: await tx.motulCompatibility.count(), research: await tx.oilResearch.count() };

    const res = await ctx.post({ liters: 4.2 });

    expect(res).toMatchObject({ status: 201, body: { liters: 4.2, recordedBy: "Marina", recordedAt: expect.any(String) } });
    const rows = await ctx.stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recordedByUserId: ctx.user.id, make: "Toyota", model: "Corolla" });
    expect(rows[0]!.liters.toNumber()).toBe(4.2);
    expect({ motul: await tx.motulCompatibility.count(), research: await tx.oilResearch.count() }).toEqual(before);
  });
});
