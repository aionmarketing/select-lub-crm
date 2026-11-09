/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/customer-services.test.ts` (adopt-modular-vertical-
 * slices 3C): its four customer-scoped GET cases, assertions unchanged. The
 * setup changed with the move — the slice alone on the harness app, over the
 * test transaction, with the caller stated rather than resolved by the auth
 * hook — so no conversations store, no channel probe and no instance name are
 * built any more. That file's other cases went where their subject is: the
 * hook's 403, the absent write routes and the conversation list's shape to
 * `apps/api/test/services.integration.test.ts`; the conversation-scoped reads
 * to `list-conversation-services`.
 *
 * Oracle: openspec/changes/complete-omie-integration/specs/customer-services/spec.md
 *   "Customer-scoped service HTTP is read-only".
 *
 * F1 (from the original file) — Customer-to-loja is a real nullable FK, so a
 *   customer in NO loja is representable, and the loja guard has a third case:
 *   such a customer is a 404, not an accidental match.
 *
 * Axis 1 — customer-scoped GET (EP)
 *   EP valid: known customer + matching loja → 200 list (Omie-origin rows)
 *   EP invalid: unknown customer id → 404
 *   EP invalid: customer in another loja → 404
 *   EP invalid: customer in NO loja (unitId NULL) → 404
 *
 * Sampled-cell
 *   GET two services newest first        | June before January     | reverse order
 *   GET unknown customer                  | 404                    | 200
 *   GET customer in another loja          | 404                    | 200
 *   GET customer with no loja             | 404                    | 200
 *
 * Decision map (list-customer-services/index.ts)
 *   !unitId                             contract-hidden — the auth hook 403s first
 *   customer missing or loja mismatch   T the three 404 its; F the 200 its
 */
import { expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { describeWithDatabase, seedUnit, withTestTransaction } from "@select-lub/core/testing";
import { serviceListSchema } from "../../contracts/http.js";
import { appOn, insertCustomer, insertService, seedScope } from "./customer-services.fixture.js";

describeWithDatabase("customer-scoped service HTTP", () => {
  const db = () => prisma as PrismaClient;

  it("lists two Omie-origin services newest first", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const january = await insertService(tx, {
        customerId: scope.customerId,
        unitId: scope.unitId,
        performedAt: new Date("2026-01-01T00:00:00.000Z"),
        description: "Troca de óleo",
      });
      const june = await insertService(tx, {
        customerId: scope.customerId,
        unitId: scope.unitId,
        performedAt: new Date("2026-06-01T00:00:00.000Z"),
        description: "Revisão",
      });
      const app = await appOn(tx, scope);
      try {
        const listed = await app.inject({
          method: "GET",
          url: `/customers/${scope.customerId}/services`,
        });

        expect(listed.statusCode).toBe(200);
        const rows = serviceListSchema.parse(listed.json());
        // The ids this test created, in order — not a count, since the customer
        // is this test's own and holds exactly these two.
        expect(rows.map((row) => row.id)).toEqual([june.id, january.id]);
        expect(rows.every((row) => row.origin === "omie" && row.omieId !== null)).toBe(true);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for an unknown customer", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope);
      try {
        // Positive control first: the same route answers 200 for the customer
        // that does exist, so the 404 below is about the id and not the route.
        const present = await app.inject({
          method: "GET",
          url: `/customers/${scope.customerId}/services`,
        });
        expect(present.statusCode).toBe(200);

        const response = await app.inject({
          method: "GET",
          url: "/customers/missing/services",
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for a customer that belongs to another loja", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const otherUnit = await seedUnit(tx);
      const elsewhere = await insertCustomer(tx, { unitId: otherUnit.id, name: "Outra" });
      await insertService(tx, { customerId: elsewhere.id, unitId: otherUnit.id });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/customers/${elsewhere.id}/services`,
        });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for a customer that belongs to no loja at all", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      // `Customer.unitId` is nullable in the schema — a pré-cadastro contact may
      // sit in no loja. The fake's flat field could not express it (F1), so the
      // guard's third case was never sampled.
      const orphan = await insertCustomer(tx, { unitId: null, name: "Sem loja" });
      await insertService(tx, { customerId: orphan.id, unitId: scope.unitId });
      const app = await appOn(tx, scope);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/customers/${orphan.id}/services`,
        });

        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }));
});
