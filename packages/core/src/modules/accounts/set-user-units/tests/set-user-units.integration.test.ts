/**
 * Test design (testing-strategy) — accounts / set-user-units
 *
 * Module role: `module_accounts`. The lookup and the replacement run inside one
 * `db.tx("accounts", …)`, so both statements ran as that role.
 *
 * Moved from `apps/api/src/auth.test.ts`: "returns 404 when attaching units to
 * an unknown CRM user", assertions unchanged. The detach half of the
 * create → attach → detach flow stays in `apps/api/test/accounts.integration.test.ts`,
 * because what it proves is the hook refusing the detached user afterwards.
 *
 * Moved from `apps/api/src/auth/prisma.harness.test.ts`: its one case, the
 * wave-1 proof that a write with its own transaction runs on the test's
 * transaction and rolls back with it. Its subject was the old store's
 * `replaceUnitIds` with an injected runner; the same claim now belongs to
 * `setUserUnits` under `db.tx`, whose runner the harness injects the same way.
 * Assertions kept: the memberships are replaced inside, and absent after.
 *
 * New here: the replacement itself, and the rollback when a loja does not
 * exist. `auth.test.ts` sampled the replacement only through the flow, and
 * never the failure.
 *
 * Setup: `buildSliceApp` with accounts' set-user-units route only, inside one
 * rolling-back transaction per test (`withTestTransaction`). The caller is
 * stated; this route is unit-exempt in the hook, so no `unitId` is given.
 *
 * The rollback case can read rows after a refused write because the refusal
 * happens inside `db.tx`, whose savepoint is rolled back on failure
 * (`kernel/db.ts`). The enclosing test transaction stays usable, unlike a
 * violation the test provokes directly.
 *
 * Oracle: openspec/changes/auth-unit-matrix specs/auth — attaching units to a
 *   user replaces the user's memberships; an unknown user is 404.
 *
 * Axes
 *   A1 the target user — a CRM row / none
 *   A2 the new set — every loja exists / one does not
 *
 * Outputs
 *   O1 200 with the profile and the new set; the rows equal the new set
 *   O2 404 with an empty body
 *   O3 500 and the previous memberships intact
 *
 * Decision map (setUserUnits)
 *   !existing T: unknown user it; F: replace it, rollback it
 *   foreign key on user_unit.unit_id T: rollback it; F: replace it
 *
 * Out of scope: 401 (the hook); whether the caller may edit that user, which
 *   no requirement restricts yet.
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
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route, setUserUnits } from "../index.js";

const db = () => prisma as PrismaClient;

/**
 * Sends `PUT /users/:id/units` as an operator.
 *
 * @param tx - The test transaction.
 * @param callerId - The operator's id.
 * @param userId - The user whose lojas change.
 * @param unitIds - The new set.
 * @returns The raw response.
 */
async function put(tx: DbClient, callerId: string, userId: string, unitIds: string[]) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "accounts", "set-user-units", route),
    caller: { userId: callerId, unitIds: [] },
  });
  try {
    return await app.inject({
      method: "PUT",
      url: `/users/${userId}/units`,
      headers: { "content-type": "application/json" },
      payload: { unitIds },
    });
  } finally {
    await app.close();
  }
}

/** The user's memberships as a sorted list, read back from the rows. */
async function membershipsOf(tx: DbClient, userId: string): Promise<string[]> {
  const rows = await tx.userUnit.findMany({ where: { userId }, select: { unitId: true } });
  return rows.map((row) => row.unitId).sort();
}

describeWithDatabase("PUT /users/:id/units", () => {
  it("returns 404 when attaching units to an unknown CRM user", () =>
    withTestTransaction(db(), async (tx) => {
      const caller = await seedUser(tx, { units: [], name: "Atendente" });
      const unknown = "00000000-0000-4000-8000-000000000099";
      // Precondition: nothing is there to attach to, so the 404 is the lookup
      // missing rather than the route refusing for another reason.
      expect(await tx.user.count({ where: { id: unknown } })).toBe(0);

      const response = await put(tx, caller.id, unknown, []);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({});
    }));

  it("replaces the user's whole membership set with the one sent", () =>
    withTestTransaction(db(), async (tx) => {
      const a = (await seedUnit(tx)).id;
      const b = (await seedUnit(tx)).id;
      const c = (await seedUnit(tx)).id;
      const caller = await seedUser(tx, { units: [a], name: "Atendente" });
      const target = await seedUser(tx, { units: [a, b], name: "Bruno Dias" });

      const response = await put(tx, caller.id, target.id, [b, c]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: target.id, name: "Bruno Dias", unitIds: [b, c] });
      // A is gone although it was not named: the body is the whole set, not a delta.
      expect(await membershipsOf(tx, target.id)).toEqual([b, c].sort());
    }));

  // `[b, b]` used to hit user_unit's (user, unit) primary key and answer 500.
  it("stores a loja named twice once", () =>
    withTestTransaction(db(), async (tx) => {
      const a = (await seedUnit(tx)).id;
      const b = (await seedUnit(tx)).id;
      const caller = await seedUser(tx, { units: [a], name: "Atendente" });
      const target = await seedUser(tx, { units: [a], name: "Bruno Dias" });

      const response = await put(tx, caller.id, target.id, [b, b]);

      expect(response.statusCode).toBe(200);
      expect(response.json().unitIds).toEqual([b]);
      expect(await membershipsOf(tx, target.id)).toEqual([b]);
    }));

  it("refuses a loja with no unit row and leaves the previous memberships intact", () =>
    withTestTransaction(db(), async (tx) => {
      const a = (await seedUnit(tx)).id;
      const b = (await seedUnit(tx)).id;
      const caller = await seedUser(tx, { units: [a], name: "Atendente" });
      const target = await seedUser(tx, { units: [a, b], name: "Bruno Dias" });
      const ghost = "unit-ghost-set-user-units";
      expect(await tx.unit.count({ where: { id: ghost } })).toBe(0);

      const response = await put(tx, caller.id, target.id, [a, ghost]);

      expect(response.statusCode).toBe(500);
      // The delete of B ran before the insert failed; the savepoint rolled it back.
      expect(await membershipsOf(tx, target.id)).toEqual([a, b].sort());
    }));
});

describeWithDatabase("setUserUnits under withTestTransaction", () => {
  it("runs its transaction on the test transaction and its rows roll back", async () => {
    let userId = "";
    await withTestTransaction(db(), async (tx) => {
      const a = await seedUnit(tx);
      const b = await seedUnit(tx);
      const user = await seedUser(tx, { units: [a.id] });
      userId = user.id;

      await createDb(tx, runInTransactionOnTx(tx)).tx("accounts", (t) => setUserUnits(t, user.id, [b.id]));

      expect(await membershipsOf(tx, user.id)).toEqual([b.id]);
    });
    expect(await db().userUnit.findMany({ where: { userId } })).toEqual([]);
  });
});
