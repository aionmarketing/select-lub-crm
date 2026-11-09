/**
 * Test design (testing-strategy) — accounts / list-units
 *
 * Module role: `module_accounts`. The route's read runs inside
 * `db.tx("accounts", …)`, and the query cases call `listUnits` inside the same
 * `db.tx("accounts", …)`. The foreign-key case is a direct write by the test
 * itself, not by the slice, and runs outside the role.
 *
 * Moved here, assertions unchanged:
 *   - from `apps/api/src/units.route.test.ts`: the five cases whose subject is
 *     the route or the schema (ordering, the foreign loja, the scoped loja's
 *     name, the refused ghost membership, the key set). Its two hook cases (no
 *     Authorization → 401, header outside the memberships → 403) go to
 *     `apps/api/test/accounts.integration.test.ts`, which runs the real hook —
 *     the 401 guards `/units` staying in `API_PATH_PREFIXES`, which only the
 *     hook can show.
 *   - from `apps/api/src/users.units.live.test.ts`: its three `listUnits` cases.
 *     They ran on committed rows with `afterAll` cleanup and read them back
 *     through the same client that wrote them; nothing in them depended on a
 *     second connection seeing the rows, so they run here inside the
 *     rolling-back transaction. Its "GET /units from the adapter buildApp
 *     chose" case is `app.ts` wiring and moves to the composition file.
 *
 * Setup: `buildSliceApp` with accounts' list-units route only, or `listUnits`
 * called directly, inside one rolling-back transaction per test
 * (`withTestTransaction`). The caller holds two freshly created lojas and a
 * third exists that they do not hold; the lojas are created inside the
 * transaction, so base lojas cannot reach the response.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (carried over from units.route.test.ts)
 *   1. "Drops a membership with no unit row" is unreachable through the route:
 *      `user_unit.unit_id` is a foreign key to `unit` with `onDelete: Restrict`.
 *      Replaced there by the assertion that the membership is refused. The
 *      query's own drop of an id with no row is still asserted directly, below,
 *      because `listUnits` promises it for any caller.
 *   2. Loja ids are FK-checked rows from `seedUnit`, not map keys.
 *   Harness constraint: a constraint violation aborts the enclosing Postgres
 *   transaction when it happens outside `db.tx`'s savepoint, so the refusal
 *   gets a test to itself and nothing follows it.
 *   Not a divergence: ordering. "Loja Centro" precedes "Loja Norte" in any
 *   collation, and the live-file names differ only by an ASCII word.
 *
 * Oracle: the auth delta of align-shipped-ui-to-revised-canvas — "`GET /units`,
 *   returning the units the caller may see with a human-readable name for
 *   each"; "each unit carries a name suitable for display, not only an
 *   identifier"; "it contains no password, no Auth service-role key, and no
 *   session token". follow-up delta — "The screen SHALL name the unit it is
 *   scoped to". The empty-list and missing-row cases' oracle is the documented
 *   contract on `listUnits`.
 *
 * Axes
 *   A1 loja membership — held by the caller / not held
 *   A2 the membership's backing row — a seeded `unit` / an id with no row
 *   A3 `x-unit-id` — the held loja the request is scoped to
 *   A4 the requested set — populated / empty
 *   A5 seeded insertion order vs alphabetical — reversed
 *
 * Outputs
 *   O1 200 with one { id, name } per held loja, ordered by name
 *   O2 a loja the caller does not hold is absent
 *   O3 a membership with no `unit` row cannot be created
 *   O4 the row's key set is exactly id and name
 *   O5 an id with no row is dropped by the query; an empty request matches none
 *
 * Decision / branch map
 *   handler `request.crmUnitIds ?? []` — contract-hidden: the hook assigns the
 *     array before any route runs and 403s a caller with none.
 *   `where: { id: { in } }` — T for the held lojas, F for the foreign one and
 *     the ghost; `in: []` matches none.
 *
 * Out of scope: 401/403 (the hook); the team list on the same screen
 *   (list-users).
 */
import { randomUUID } from "node:crypto";
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
import { listUnits, route } from "../index.js";

const db = () => prisma as PrismaClient;

/**
 * Seeds three named lojas and puts a caller on the first two.
 *
 * Insertion order is against alphabetical order, so insertion order and name
 * order give different answers.
 *
 * @param tx - The test transaction.
 * @returns The three loja ids and the caller's id.
 */
async function seedLojas(tx: DbClient) {
  const a = (await seedUnit(tx, { name: "Loja Norte" })).id;
  const b = (await seedUnit(tx, { name: "Loja Centro" })).id;
  const c = (await seedUnit(tx, { name: "Loja Sul" })).id;
  const caller = await seedUser(tx, {
    units: [a, b],
    email: `caller-${randomUUID().slice(0, 8)}@test.local`,
    name: "Zuleica Atendente",
  });
  return { a, b, c, callerId: caller.id };
}

/**
 * Drives `GET /units` as a caller holding lojas A and B, scoped to `unitId`.
 *
 * @param tx - The test transaction.
 * @param lojas - From {@link seedLojas}.
 * @param unitId - The loja the request is scoped to.
 * @returns The raw response.
 */
async function get(tx: DbClient, lojas: Awaited<ReturnType<typeof seedLojas>>, unitId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "accounts", "list-units", route),
    caller: { userId: lojas.callerId, unitId, unitIds: [lojas.a, lojas.b] },
  });
  try {
    return await app.inject({ method: "GET", url: "/units" });
  } finally {
    await app.close();
  }
}

/**
 * Calls the query directly, under the module's role.
 *
 * @param tx - The test transaction.
 * @param requested - The ids asked for.
 * @returns The rows.
 */
function query(tx: DbClient, requested: string[]) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("accounts", (t) => listUnits(t, requested));
}

describeWithDatabase("GET /units", () => {
  it("lists the caller's lojas with a display name, ordered by name", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);

      const response = await get(tx, lojas, lojas.a);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { id: lojas.b, name: "Loja Centro" },
        { id: lojas.a, name: "Loja Norte" },
      ]);
    }));

  it("leaves out a loja the caller does not belong to", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);

      const response = await get(tx, lojas, lojas.a);

      expect(response.json().map((row: { id: string }) => row.id)).not.toContain(lojas.c);
      // Loja Sul exists and is named; it is filtered out, not missing.
      expect(await tx.unit.findUniqueOrThrow({ where: { id: lojas.c } })).toMatchObject({
        name: "Loja Sul",
      });
    }));

  it("names the loja the x-unit-id header selects, so the screen can print it", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);

      const response = await get(tx, lojas, lojas.b);

      const scoped = response.json().find((row: { id: string }) => row.id === lojas.b);
      expect(scoped.name).toBe("Loja Centro");
    }));

  // Nothing follows the rejection in this test on purpose: this write is the
  // test's own, outside `db.tx`'s savepoint, so the violation leaves the
  // enclosing Postgres transaction aborted and any later statement would fail
  // on the abort rather than on its own merits.
  it("cannot be given a membership whose loja has no unit row", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);
      const ghost = `unit-ghost-${randomUUID().slice(0, 8)}`;
      // Precondition: nothing is there to name.
      expect(await tx.unit.findUnique({ where: { id: ghost } })).toBeNull();

      await expect(
        tx.userUnit.create({ data: { userId: lojas.callerId, unitId: ghost } }),
      ).rejects.toThrow(/foreign key constraint/i);
    }));

  it("carries no field beyond the identifier and the name", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);

      const response = await get(tx, lojas, lojas.a);

      expect(Object.keys(response.json()[0]).sort()).toEqual(["id", "name"]);
    }));
});

describeWithDatabase("listUnits", () => {
  it("lists the requested lojas with their names, ordered by name", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);

      const rows = await query(tx, [lojas.b, lojas.a]);

      expect(rows).toEqual([
        { id: lojas.b, name: "Loja Centro" },
        { id: lojas.a, name: "Loja Norte" },
      ]);
    }));

  it("drops a requested id that has no unit row", () =>
    withTestTransaction(db(), async (tx) => {
      const lojas = await seedLojas(tx);
      const ghost = `unit-ghost-${randomUUID().slice(0, 8)}`;

      const rows = await query(tx, [lojas.a, ghost]);

      expect(rows).toEqual([{ id: lojas.a, name: "Loja Norte" }]);
    }));

  it("matches no loja for an empty request", () =>
    withTestTransaction(db(), async (tx) => {
      await seedLojas(tx);

      const rows = await query(tx, []);

      expect(rows).toEqual([]);
    }));
});
