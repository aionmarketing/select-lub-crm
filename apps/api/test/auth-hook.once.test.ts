/**
 * Test design — the auth hook is attached exactly once.
 *
 * Oracle: buildApp registers `registerAuthHook` once; the `onRequest` hook
 * therefore validates the token and loads the CRM user once per request.
 *
 * Why this exists: wave 1 of route-tests-on-real-database (#102) spliced the
 * store wiring in app.ts and left the registration line duplicated, so every
 * request validated the token twice and hit the auth store twice. Every suite
 * stayed green because the second pass reached the same decision, so nothing
 * observable from a response could catch it. Counting calls into the injected
 * `getUser` is the only vantage point that can.
 *
 * Decision map
 *   one authenticated request      T: getUser called exactly once
 *   a second request               T: exactly once more (not cumulative doubling)
 *
 * Runs on the real stores inside a rolling-back transaction, because the memory
 * stores are gone. What is counted does not move: the call count is a property
 * of app wiring rather than of any store. The only change is that `/units` now
 * answers from a real `unit` row and a real `user_unit` membership.
 *
 * ASSERTION THAT ONLY HELD ON THE FAKE
 *   `memberUnitIds: ["unit-once"]` named a loja that did not exist. It seeded a
 *   memory auth store keyed on that string, and the memory units store returned
 *   a row for whatever id it was handed, so the 200 proved nothing about a
 *   membership. Against the real adapters a membership is a `user_unit` row whose
 *   `unit_id` is a foreign key, so the unit is created here and the 200 now
 *   depends on the auth store reading a real membership — which is precisely the
 *   read the hook performs once per request and this file counts.
 *
 * Out of scope: what the hook decides (hook.test.ts).
 */
import { afterEach, expect, it } from "vitest";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";
import { TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";
import type { kernel } from "@select-lub/core";

const db = () => prisma as PrismaClient;

describeWithDatabase("auth hook registration", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("validates the token exactly once per request", () =>
    withTestTransaction(db(), async (tx) => {
      let calls = 0;
      const countingGetUser: kernel.GetUser = async (token) => {
        calls += 1;
        return token === TEST_ACCESS_TOKEN
          ? { id: TEST_USER_ID, email: "attendant@example.com" }
          : null;
      };
      const unit = await seedUnit(tx);
      await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
      const app = await buildApp({
        db: tx,
        runInTransaction: runInTransactionOnTx(tx),
        getUser: countingGetUser,
      });
      close = () => app.close();
      const headers = {
        authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        "x-unit-id": unit.id,
      };

      const first = await app.inject({ method: "GET", url: "/units", headers });
      expect(first.statusCode).toBe(200);
      expect(calls).toBe(1);

      const second = await app.inject({ method: "GET", url: "/units", headers });
      expect(second.statusCode).toBe(200);
      expect(calls).toBe(2);
    }));
});
