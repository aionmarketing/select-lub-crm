/**
 * Test design — the per-test transaction harness.
 *
 * Oracle: openspec/changes/route-tests-on-real-database, spec "API route
 * suites exercise the real database adapters", scenario "A route test leaves
 * no rows behind"; design D1 (rollback) and D2 (run-in-transaction shim).
 *
 * Decision map
 *   withTestTransaction rolls back on success     T: row absent afterwards
 *   withTestTransaction rolls back on throw       T: row absent, error rethrown
 *   nested $transaction on a tx client            T: rejected (the defect D2 removes)
 *   runInTransactionOnTx on the same tx           T: resolves, write visible inside
 *
 * Every case creates its own unit and asserts on that id only; the database
 * also holds the pristine base and possibly the demo seed.
 *
 * Out of scope: the gate (gate.test.ts), the seed helpers (seed.test.ts), any
 * real adapter (each adapter proves itself under the harness in its own app).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@select-lub/core/db";
import { describeWithDatabase } from "./gate.js";
import { runInTransactionOnTx, withTestTransaction } from "./transaction.js";

describeWithDatabase("withTestTransaction", () => {
  const db = () => prisma as PrismaClient;

  it("rolls back a successful body: the row is visible inside and gone afterwards", async () => {
    const id = `t-unit-${randomUUID()}`;
    const seen = await withTestTransaction(db(), async (tx) => {
      await tx.unit.create({ data: { id, name: "rolled back" } });
      return tx.unit.findUnique({ where: { id }, select: { id: true } });
    });
    expect(seen).toEqual({ id });
    expect(await db().unit.findUnique({ where: { id } })).toBeNull();
  });

  it("rolls back a throwing body and rethrows the original error", async () => {
    const id = `t-unit-${randomUUID()}`;
    const boom = new Error("test body failed");
    await expect(
      withTestTransaction(db(), async (tx) => {
        await tx.unit.create({ data: { id, name: "rolled back on throw" } });
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await db().unit.findUnique({ where: { id } })).toBeNull();
  });

  it("rejects an adapter that opens its own $transaction on the transaction client", async () => {
    // This is the shape every adapter had before design D2: `prisma.$transaction(...)`
    // on whatever client it was handed. On a transaction client there is no
    // `$transaction` to call, so the adapter cannot run under this harness at all.
    const legacyAdapter = (client: PrismaClient) => ({
      async write(id: string) {
        await client.$transaction([client.unit.create({ data: { id, name: "legacy" } })]);
      },
    });
    await expect(
      withTestTransaction(db(), async (tx) => {
        await legacyAdapter(tx as unknown as PrismaClient).write(`t-unit-${randomUUID()}`);
      }),
    ).rejects.toThrow(/\$transaction is not a function/);
  });

  it("runInTransactionOnTx runs the callback on the open transaction and its write is visible", async () => {
    const id = `t-unit-${randomUUID()}`;
    const seen = await withTestTransaction(db(), async (tx) => {
      const run = runInTransactionOnTx(tx);
      await run(async (inner) => {
        await inner.unit.create({ data: { id, name: "via shim" } });
      });
      return tx.unit.findUnique({ where: { id }, select: { id: true } });
    });
    expect(seen).toEqual({ id });
    expect(await db().unit.findUnique({ where: { id } })).toBeNull();
  });
});
