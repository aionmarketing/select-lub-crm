/**
 * Test design (testing-strategy) — the attendant-fill store port (task 5.8)
 *
 * SUT: `createPrismaAttendantFillStore` on the rolling-back transaction (Prisma only, tested on the
 *   real database: the repo forbids memory stores; orchestrator 2026-09-30).
 *
 * Oracle: `oil-attendant-fill` "An attendant volume is stored per identity, with who and when":
 *   insert-only, keyed as the caches key an identity, the latest row the one read.
 *
 * Cells (state | expected | the bug it would miss)
 *   one insert                           | read back with the author's name and instant | the name not joined
 *   two for one identity                 | the later read, both kept                    | an update in place; the first read
 *   an accent and case variant           | the same identity                            | a volume split by spelling
 *   another identity, an incomplete one  | nothing read                                 | a volume crossing models
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createPrismaAttendantFillStore } from "../src/modules/quotes/internal/store/attendant-fill.js";
import { describeWithDatabase, seedUnit, seedUser, withTestTransaction } from "../src/testing/index.js";

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

const identity = () => ({ make: "Toyota", year: 2019, model: `Corolla ${randomUUID().slice(0, 6)}`, version: "XEi" });

describeWithDatabase("the attendant-fill store", () => {
  itInTx("inserts a volume and reads the latest per identity, with who and when", async (tx) => {
    const unit = await seedUnit(tx);
    const user = await seedUser(tx, { units: [unit.id], name: "Marina" });
    const car = identity();
    const store = createPrismaAttendantFillStore(tx);

    const first = await store.insert({ identity: car, liters: 4.2, recordedByUserId: user.id, recordedAt: new Date("2026-09-20T13:00:00.000Z") });
    expect(first).toMatchObject({ liters: 4.2, recordedBy: "Marina", recordedAt: new Date("2026-09-20T13:00:00.000Z") });
    expect(await store.latest(car)).toMatchObject({ id: first.id, liters: 4.2 });

    const second = await store.insert({ identity: car, liters: 4.4, recordedByUserId: user.id, recordedAt: new Date("2026-09-21T13:00:00.000Z") });
    expect(await store.latest({ ...car, make: "TOYOTA", version: "xei" })).toMatchObject({ id: second.id, liters: 4.4 });
    expect(await tx.oilAttendantFill.count({ where: { identityKey: first.identityKey } })).toBe(2);

    expect(await store.latest(identity())).toBeNull();
    expect(await store.latest({ ...car, version: null })).toBeNull();
  });
});
