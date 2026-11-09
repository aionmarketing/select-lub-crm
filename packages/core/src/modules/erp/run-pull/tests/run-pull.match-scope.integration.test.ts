/**
 * Test design (testing-strategy) — `runPull` hands its match scope down (the #163
 * follow-up)
 *
 * SUT: `runPull(db, mode, env, source, matchScope, log)`, the composition the
 *   worker calls, through `runOmiePull` and `pullOmieClients` to the match pass,
 *   on the real database inside one rolling-back transaction, over a mock source
 *   whose ids are this test's own.
 *
 * Why: the pull tests pass a scope straight to `pullOmieClients` or
 *   `matchUnlinkedCustomers`, and a spy test pins that the WORKER's call (no
 *   scope) reaches the store as none. Nothing drove the whole `runPull` →
 *   `runOmiePull` path WITH a scope, so dropping it at either hop would have
 *   left every test green while a scoped caller matched database-wide.
 *
 * Oracle: `erp/run-pull/index.ts`'s contract — `matchScope` "restricts the match
 *   pass to these customers". Two unlinked customers, each with a tax id no mock
 *   client carries, so the match pass creates an Omie client for any candidate
 *   it is given (`incluir`) and links it. Only the scoped one may end up linked.
 *   Mutation-checked: `runPull` not passing `matchScope` to `runOmiePull` links
 *   both.
 */
import { randomInt } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import { describeWithDatabase, runInTransactionOnTx, seedUnit, withTestTransaction } from "../../../../testing/index.js";
import { runPull } from "../index.js";
import { scopedMockOmie } from "./scoped-mock.js";

const db = () => prisma as PrismaClient;

/** Eleven digits no mock client carries, so no search can hit it. */
function freshTaxId(): string {
  return Array.from({ length: 11 }, () => randomInt(10)).join("");
}

function omieIdOf(tx: DbClient, id: string) {
  return tx.customer.findUniqueOrThrow({ where: { id }, select: { omieId: true } }).then((row) => row.omieId);
}

describeWithDatabase("runPull's match scope", () => {
  it("reaches the match pass: only the scoped customer is matched", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const unlinked = (name: string) =>
        tx.customer.create({
          data: { name, taxId: freshTaxId(), unitId: unit.id, origin: "CRM", status: "active" },
        });
      const inScope = await unlinked("Dentro do escopo");
      const outOfScope = await unlinked("Fora do escopo");

      await runPull(
        createDb(tx, runInTransactionOnTx(tx)),
        "full",
        { OMIE_MOCK: "1" },
        scopedMockOmie().source,
        { customerIds: [inScope.id] },
        () => undefined,
      );

      // Positive control: the scoped candidate was matched (created in Omie and linked).
      expect(await omieIdOf(tx, inScope.id)).not.toBeNull();
      expect(await omieIdOf(tx, outOfScope.id)).toBeNull();
    }));
});
