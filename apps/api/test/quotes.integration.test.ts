/**
 * Test design — the quotes module is mounted on the api composition root
 *
 * SUT: `buildApp` from `src/app.ts` with the quotes module's plugin on it, behind
 *   `apps/api`'s real auth hook, in one rolling-back transaction.
 *
 * Why this file is in apps/api and not in the slices' tests (wave 2 ruling on the
 * auth hook): every quotes slice test mounts on `buildSliceApp`, which has no auth
 * hook and states its caller. So two things are invisible to all of them, and only
 * this file can see them:
 *   1. Whether `app.ts` registers the quotes plugin at all. If it stopped, every
 *      slice test would still pass.
 *   2. The hook's own answers in front of these routes: 401 with no bearer token,
 *      403 on a unit the caller is not in, and the unit taken from `X-Unit-Id`.
 *      Asserted against a stand-in hook, those would pass vacuously.
 * Everything the slices themselves decide — cache reuse, pricing, the handler's
 * own 404s and 400s — is tested in the slices, not repeated here.
 *
 * The positive controls are answers only a MOUNTED slice can give. A 404 is not
 * one: Fastify answers 404 for a route that was never registered. So GET is
 * asserted by a `no_spec` 200 body, which only the get-quote-options handler
 * produces, and POST by a validation 400, which only a registered schema raises.
 *
 * No test here can reach a provider. The quote path has no provider port any more
 * (background-oil-research D15: research runs in the worker), so `fetch` itself — which
 * Motul, Tecfil, the web search and OpenAI all go through — is trapped to throw,
 * and each case asserts it was never called.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { quoteOptionsResultSchema } from "@select-lub/shared-types";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

/**
 * Builds the real app over the test transaction with a caller who belongs to one unit,
 * and one vehicle in that unit whose identity is incomplete — so a quote-options request
 * that reaches the handler answers `no_spec` without consulting any port.
 *
 * @param tx - The test transaction.
 * @returns The app, the unit, a unit the caller is NOT in, the vehicle, and a counter of
 *   port calls that must stay at zero.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const foreign = await seedUnit(tx);
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const customer = await tx.customer.create({
    data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" },
    select: { id: true },
  });
  const vehicle = await tx.vehicle.create({
    data: { customerId: customer.id, origin: "manual", make: "Ford", model: "Ka", year: 2018 },
    select: { id: true },
  });

  const trap = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("a provider must not be reached by a composition test");
  });

  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
  });
  return { app, unit, foreign, vehicleId: vehicle.id, portCalls: () => trap.mock.calls.length };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const bearer = { authorization: `Bearer ${TEST_ACCESS_TOKEN}` };

describeWithDatabase("quotes module on the api composition root", () => {
  const db = () => prisma as PrismaClient;

  it("mounts GET quote-options and resolves the unit from X-Unit-Id", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const res = await ctx.app.inject({
          method: "GET",
          url: `/vehicles/${ctx.vehicleId}/quote-options`,
          headers: { ...bearer, "x-unit-id": ctx.unit.id },
        });

        // Only the get-quote-options handler answers `no_spec`; an unmounted route is
        // a 404, and a unit the hook resolved wrongly would be the handler's own 404.
        expect(res.statusCode).toBe(200);
        expect(quoteOptionsResultSchema.parse(res.json())).toEqual({ status: "no_spec", reason: "incomplete_identity", missingFields: ["version"] });
        expect(ctx.portCalls()).toBe(0);
      } finally {
        await ctx.app.close();
      }
    }));

  it("mounts POST oil-research/refetch", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const res = await ctx.app.inject({
          method: "POST",
          url: `/vehicles/${ctx.vehicleId}/oil-research/refetch`,
          headers: { ...bearer, "x-unit-id": ctx.unit.id },
        });

        // Only the refetch handler answers a POST here with the quote-options union.
        expect(res.statusCode).toBe(200);
        expect(quoteOptionsResultSchema.parse(res.json())).toEqual({ status: "no_spec", reason: "incomplete_identity", missingFields: ["version"] });
        expect(ctx.portCalls()).toBe(0);
      } finally {
        await ctx.app.close();
      }
    }));

  it("mounts POST quotes with its body schema", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const res = await ctx.app.inject({
          method: "POST",
          url: `/vehicles/${ctx.vehicleId}/quotes`,
          headers: { ...bearer, "x-unit-id": ctx.unit.id, "content-type": "application/json" },
          payload: { generatedMessageText: "proposta" },
        });

        // A body missing `lines` is refused by the registered schema, before the handler.
        // An unregistered route would be a 404 instead.
        expect(res.statusCode).toBe(400);
        expect(ctx.portCalls()).toBe(0);
      } finally {
        await ctx.app.close();
      }
    }));

  it("puts the auth hook in front: no bearer token is a 401", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const res = await ctx.app.inject({
          method: "GET",
          url: `/vehicles/${ctx.vehicleId}/quote-options`,
          headers: { "x-unit-id": ctx.unit.id },
        });

        expect(res.statusCode).toBe(401);
        expect(ctx.portCalls()).toBe(0);
      } finally {
        await ctx.app.close();
      }
    }));

  it("refuses a unit the caller does not belong to with a 403", () =>
    withTestTransaction(db(), async (tx) => {
      const ctx = await setup(tx);
      try {
        const res = await ctx.app.inject({
          method: "GET",
          url: `/vehicles/${ctx.vehicleId}/quote-options`,
          headers: { ...bearer, "x-unit-id": ctx.foreign.id },
        });

        // The hook's refusal, not the handler's: the caller is a member of `unit` only,
        // and the handler would answer 404 for a vehicle outside its unit.
        expect(res.statusCode).toBe(403);
        expect(ctx.portCalls()).toBe(0);
      } finally {
        await ctx.app.close();
      }
    }));
});
