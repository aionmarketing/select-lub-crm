/**
 * Test design — the customers module is mounted on the api composition root
 *
 * Moved (adopt-modular-vertical-slices 4B), runs under module_customers:
 *   - from apps/api/src/cadastro.test.ts: its one auth-hook case (403 for a unit that
 *     is not a membership). Its other 21 cases went to the customers slices'
 *     `tests/<slice>.route.integration.test.ts`.
 *   - from apps/api/src/cadastro.vehicles.test.ts: its one auth-hook case (a vehicle
 *     create under a unit the attendant is not in is refused, and writes no row).
 *
 * SUT: `buildApp` from `src/app.ts` with the customers module's plugin on it, behind
 *   `apps/api`'s real auth hook, in one rolling-back transaction.
 *
 * Why this file is in apps/api and not in the slices' tests (wave 2 ruling on the
 * auth hook): every customers slice test mounts on `buildSliceApp`, which has no auth
 * hook and states its caller. So two things are invisible to all of them, and only
 * this file can see them:
 *   1. Whether `app.ts` registers the customers plugin at all. If it stopped, every
 *      slice test would still pass.
 *   2. The hook's own answer in front of these routes: 403 on a unit the caller is
 *      not in, and the unit taken from `X-Unit-Id`.
 *
 * The positive control is an answer only a MOUNTED slice can give: a 200 `[]` from
 * the list-customer-pendings handler. Fastify answers 404 for a route that was
 * never registered, and the handler itself answers 404 for a customer outside the
 * unit the hook resolved — so the 200 also proves the unit came from `X-Unit-Id`.
 *
 * No test here can reach the live Evolution instance. The channel probe `buildApp`
 * wires is consulted only by the conversations store's enqueue, media enqueue and
 * media fetch; this file routes to none of them (memory:
 * buildapp-channel-probe-calls-evolution-live). Omie is an injected
 * `createFakeOmie`.
 *
 * Oracle: cadastro-reconciliation-backend omie-sync; the hook's membership rule.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { clients, kernel } from "@select-lub/core";
import { createCadastroStore } from "@select-lub/core/modules/customers";
import { expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

/**
 * Builds the real app over the test transaction with a caller who belongs to one
 * unit, and one customer in that unit.
 *
 * @param tx - The test transaction.
 * @returns The app, the unit, the customer id and the bearer + unit headers.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const customer = await tx.customer.create({
    data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });

  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    omieAdapter: clients.omie.createFakeOmie(),
  });
  const headers = { "x-unit-id": unit.id, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
  return { app, unit, customerId: customer.id, headers };
}

describeWithDatabase("customers module on the api composition root", () => {
  const db = () => prisma as PrismaClient;

  it("mounts GET reconciliation-pendings and resolves the unit from X-Unit-Id", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const response = await ctx.app.inject({
          method: "GET",
          url: `/customers/${ctx.customerId}/reconciliation-pendings`,
          headers: ctx.headers,
        });

        // Only the mounted handler answers 200; an unmounted route is a 404, and
        // a unit the hook resolved wrongly would be the handler's own 404.
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
      } finally {
        await ctx.app.close();
      }
    }));

  it("returns 403 when the unit header is not a membership", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      const foreign = await seedUnit(tx);
      try {
        const response = await ctx.app.inject({
          method: "GET",
          url: `/customers/${ctx.customerId}/reconciliation-pendings`,
          headers: { ...ctx.headers, "x-unit-id": foreign.id },
        });

        // A real unit that exists but which `seedUser` did not make the attendant
        // a member of, so this is the membership refusal and not a missing row.
        expect(response.statusCode).toBe(403);
      } finally {
        await ctx.app.close();
      }
    }));

  it("returns 403 and creates no row when the unit header names a unit the attendant is not in", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      // The moved case's customer had one vehicle; the assertion counts it.
      await tx.vehicle.create({
        data: { customerId: ctx.customerId, plate: "ABC1D23", origin: "manual" },
      });
      const cadastro = createCadastroStore(kernel.createDb(tx, runInTransactionOnTx(tx)));
      const other = await seedUnit(tx);
      try {
        const response = await ctx.app.inject({
          method: "POST",
          url: `/customers/${ctx.customerId}/vehicles`,
          headers: { ...ctx.headers, "content-type": "application/json", "x-unit-id": other.id },
          payload: { plate: "ABC1D23" },
        });

        // The auth hook answers before the handler, so this is a membership
        // refusal, not a cadastro 404. `seedUser` gave the attendant only the
        // first unit, which is what makes the two distinguishable at all.
        expect(response.statusCode).toBe(403);
        expect(await cadastro.listVehicles(ctx.customerId)).toHaveLength(1);
      } finally {
        await ctx.app.close();
      }
    }));
});
