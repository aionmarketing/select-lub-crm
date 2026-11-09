/**
 * Test design (testing-strategy)
 *
 * SUT: `POST /plate-lookups` behind `apps/api`'s real auth hook, through the
 *   real `buildApp`, in-process via `inject`, inside one rolling-back
 *   transaction on the worktree database (`withTestTransaction`).
 *
 * WHY THIS FILE IS IN apps/api AND NOT IN THE SLICE. The slice's own HTTP
 *   tests (packages/core/src/modules/plate-lookup/lookup-plate/tests/) run on
 *   `buildSliceApp`, which has no auth hook: the caller is stated by the test.
 *   The hook that answers 401 and resolves `X-Unit-Id` against the caller's
 *   memberships is `packages/core/src/kernel/auth/hook.ts` (converged with the
 *   kernel's own in wave 5.2), and only this app's `buildApp` registers it. So
 *   the two assertions that need THAT hook run through `buildApp` (ruling W2-C9).
 *   They could move into the slice once `buildSliceApp` can mount the real hook.
 *
 * What it pins, both about the endpoint that spends money:
 *   1. It is behind authentication at all — i.e. `/plate-lookups` is inside
 *      `resolve-unit.ts`'s prefix list. A path outside that list skips the
 *      hook, and a billing endpoint reachable without a token would spend on
 *      anyone's request. Moved from apps/api/src/plate-lookup/routes.test.ts.
 *   2. A billed hop is attributed to the loja the HOOK resolved from
 *      `X-Unit-Id` and the caller's real membership. The slice's own test pins
 *      its use of `unitIdOf`; this pins the hook's resolution. A different
 *      defect fails each.
 *
 * Positive control: case 2 is the same request with a bearer token, and it is
 *   a 200 that reaches the provider. So case 1's 401 comes from the hook, not
 *   from a route that answers nothing.
 *
 * NO TEST HERE MAY REACH A REAL PROVIDER. `plateProvider` is passed explicitly
 *   to `buildApp` in both cases, so it never falls back to
 *   `createPlacasProvider()` (memory: tour-config-blanks-the-wrong-plate-var).
 *   Both assert the injected provider's call count — zero on the refusal.
 *
 * Module role: the slice's queries run under `module_plate_lookup`.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { clients } from "@select-lub/core";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

const db = () => prisma as PrismaClient;

/** A valid old-format plate (`[A-Z]{3}\d{4}`) unique to this run. */
function uniquePlate(): string {
  const letters = Array.from(
    { length: 3 },
    () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)],
  ).join("");
  return `${letters}${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

/** A local provider that counts what it was asked for, and answers a billed hit. */
function countingProvider(): clients.PlateProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test",
    calls,
    async lookup(plate) {
      calls.push(plate);
      return clients.placasProviders.foundOrNotFound(
        { make: "VW", model: "GOL", year: 2021 },
        { source: "provider", provider: "agregados-propria", billed: true },
      );
    },
  };
}

/** The caller's loja and their real membership on it. */
async function seedCaller(tx: DbClient) {
  const unit = await seedUnit(tx);
  await seedUser(tx, {
    id: TEST_USER_ID,
    units: [unit.id],
    email: `caller-${randomUUID().slice(0, 8)}@test.local`,
  });
  return unit.id;
}

async function post(
  tx: DbClient,
  unitId: string,
  plate: string,
  plateProvider: clients.PlateProvider,
  { authenticate }: { authenticate: boolean },
) {
  const app = await buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    plateProvider,
  });
  try {
    return await app.inject({
      method: "POST",
      url: "/plate-lookups",
      headers: {
        "content-type": "application/json",
        "x-unit-id": unitId,
        ...(authenticate ? { authorization: `Bearer ${TEST_ACCESS_TOKEN}` } : {}),
      },
      payload: { plate },
    });
  } finally {
    await app.close();
  }
}

describeWithDatabase("POST /plate-lookups behind the api's auth hook", () => {
  it("returns 401 when unauthenticated, without reaching the provider", () =>
    withTestTransaction(db(), async (tx) => {
      const unitId = await seedCaller(tx);
      const provider = countingProvider();
      const plate = uniquePlate();

      const response = await post(tx, unitId, plate, provider, { authenticate: false });

      expect(response.statusCode).toBe(401);
      expect(provider.calls).toEqual([]);
      expect(await tx.plateLookupCall.count({ where: { plate } })).toBe(0);
      expect(await tx.plateLookup.findUnique({ where: { plate } })).toBeNull();
    }));

  it("attributes the billed hop to the loja the hook resolved from X-Unit-Id", () =>
    withTestTransaction(db(), async (tx) => {
      const unitId = await seedCaller(tx);
      const provider = countingProvider();
      const plate = uniquePlate();

      const response = await post(tx, unitId, plate, provider, { authenticate: true });

      expect(response.statusCode).toBe(200);
      expect(provider.calls).toEqual([plate]);
      const hops = await tx.plateLookupCall.findMany({ where: { plate } });
      expect(hops).toHaveLength(1);
      expect(hops[0]).toMatchObject({ provider: "agregados-propria", unitId });
    }));
});
