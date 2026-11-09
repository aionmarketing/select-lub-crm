/**
 * Test design (testing-strategy) — accounts / get-me
 *
 * Module role: `module_accounts`. This slice opens no `db.tx` at all — it
 * answers from the `request.crm*` fields — so no statement here runs under the
 * role; the database is used only to create real unit rows for the ids.
 *
 * Moved from `apps/api/src/auth.test.ts` ("GET /auth/me", three cases),
 * assertions unchanged. The caller used to be resolved by the real auth hook
 * from seeded `user_unit` rows; `buildSliceApp` has no hook, so the test states
 * the caller's memberships directly (`caller.unitIds`). What the hook does with
 * those rows is asserted in `apps/api/test/accounts.integration.test.ts`.
 *
 * Setup: `buildSliceApp` with accounts' get-me route only, inside one
 * rolling-back transaction per test (`withTestTransaction`).
 *
 * Oracle: openspec/changes/auth-unit-matrix specs/auth — Me endpoint:
 *   currentUnitId when resolvable, omitted otherwise; unitIds are the caller's
 *   memberships only.
 *
 * Decision map (get-me handler)
 *   currentUnitId spread T: header membership it; F: two memberships no header it
 *   sole membership omit header T: one-membership it
 *   x-unit-id typeof string F — inject sends a string; an array header is
 *     infeasible here
 *   crmName.length > 0 T: every moved case; F: empty-name it (new — the old
 *     file left this arm unsampled)
 *
 * Out of scope: the hook's 401/403 (apps/api/test/accounts.integration.test.ts).
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
  withTestTransaction,
  type SliceCaller,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const db = () => prisma as PrismaClient;
const userId = "11111111-1111-1111-1111-111111111111";

/**
 * Builds an app carrying only this slice, writing into the test's transaction.
 *
 * @param tx - The test transaction.
 * @param caller - Who the request is from, as the auth hook would have resolved it.
 * @returns The app; the test closes it.
 */
async function appOn(tx: DbClient, caller: SliceCaller) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "accounts", "get-me", route),
    caller,
  });
}

describeWithDatabase("GET /auth/me", () => {
  it("lists both memberships and omits a foreign unit id", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedUnit(tx);
      const lojaB = await seedUnit(tx);
      const lojaC = await seedUnit(tx);
      const app = await appOn(tx, {
        userId,
        unitIds: [lojaA.id, lojaB.id],
        email: "attendant@test.local",
        name: "Atendente",
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { "x-unit-id": lojaA.id },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { unitIds: string[]; currentUnitId?: string };
      expect(body.unitIds.sort()).toEqual([lojaA.id, lojaB.id].sort());
      expect(body.currentUnitId).toBe(lojaA.id);
      expect(body.unitIds).not.toContain(lojaC.id);
      await app.close();
    }));

  it("omits currentUnitId when two memberships are present and the unit header is omitted", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedUnit(tx);
      const lojaB = await seedUnit(tx);
      const app = await appOn(tx, {
        userId,
        unitIds: [lojaA.id, lojaB.id],
        email: "attendant@test.local",
        name: "Atendente",
      });

      const response = await app.inject({ method: "GET", url: "/auth/me" });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { currentUnitId?: string; unitIds: string[] };
      expect(body.unitIds.sort()).toEqual([lojaA.id, lojaB.id].sort());
      expect(body.currentUnitId).toBeUndefined();
      await app.close();
    }));

  it("uses the sole membership as currentUnitId when the unit header is omitted", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedUnit(tx);
      const app = await appOn(tx, {
        userId,
        unitIds: [lojaA.id],
        email: "attendant@test.local",
        name: "Atendente",
      });

      const response = await app.inject({ method: "GET", url: "/auth/me" });

      expect(response.statusCode).toBe(200);
      expect(response.json().currentUnitId).toBe(lojaA.id);
      await app.close();
    }));

  it("falls back to the e-mail as the name when the caller has no CRM name", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedUnit(tx);
      const app = await appOn(tx, {
        userId,
        unitIds: [lojaA.id],
        email: "sem-nome@test.local",
        name: "",
      });

      const response = await app.inject({ method: "GET", url: "/auth/me" });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { id: string; name: string; email: string };
      expect(body.id).toBe(userId);
      expect(body.name).toBe("sem-nome@test.local");
      await app.close();
    }));
});
