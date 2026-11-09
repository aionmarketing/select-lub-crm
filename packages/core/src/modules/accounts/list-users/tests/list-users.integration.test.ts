/**
 * Test design (testing-strategy) — accounts / list-users
 *
 * Module role: `module_accounts`. The route's read runs inside
 * `db.tx("accounts", …)`, and the query cases below call `listUsers` inside the
 * same `db.tx("accounts", …)`, so every statement under test ran as that role.
 *
 * Moved here, assertions unchanged:
 *   - from `apps/api/src/users.route.test.ts`: the five cases whose subject is
 *     the route (ordering, the stranger, header independence, the complete
 *     membership set, the key set). Its three hook cases (no Authorization,
 *     unknown Bearer, header outside the memberships) go to
 *     `apps/api/test/accounts.integration.test.ts`, which runs the real hook.
 *   - from `apps/api/src/users.units.live.test.ts`: its four `listUsers` cases.
 *     They ran on committed rows with `afterAll` cleanup; core has no live pass,
 *     so they run here inside the rolling-back transaction, which also removes
 *     the cleanup. Its "GET /users from the adapter buildApp chose" case is about
 *     `app.ts` wiring and moves to the composition file.
 *
 * Setup: `buildSliceApp` with accounts' list-users route only, or `listUsers`
 * called directly, inside one rolling-back transaction per test
 * (`withTestTransaction`) on the worktree database. The caller is stated
 * (`caller.unitIds`) rather than resolved by the hook, and is ALSO a real
 * `user` row with those memberships, because a real caller appears in its own
 * team list.
 *
 * The caller holds two freshly created lojas and a third exists that they do
 * not hold, so "the users I may see" is a proper subset of "the users that
 * exist". Because the lojas are created inside the transaction, base and demo
 * `user` rows (which hold only base lojas) can never enter the response.
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (carried over from users.route.test.ts)
 *   1. `unitIds` came back in a fixed order. The nested select has no orderBy,
 *      so it is asserted as a set.
 *   2. The caller was not a user; a real caller is listed too.
 *   3. Memberships could name lojas that did not exist; `user_unit.unit_id` is
 *      a FK to `unit`.
 *   Not a divergence: the accented name. The database sorts by its collation,
 *   and this one (`en_US.utf8`) files "Ávila" with A. Collation-dependent
 *   rather than guaranteed (tasks.md records a `C.UTF-8` cluster failing it).
 *
 * Oracle: the auth delta of align-shipped-ui-to-revised-canvas — "returning the
 *   CRM users the caller may see with each user's unit memberships, scoped by
 *   the caller's own memberships"; "each row carries the user's identifier,
 *   e-mail, name, and the units that user belongs to"; "it contains no
 *   password, no Auth service-role key, and no session token". The empty-list
 *   case's oracle is the documented contract on `listUsers` ("an empty list
 *   matches nobody").
 *
 * Axes
 *   A1 lojas shared with the caller — 0 / 1 / 2
 *   A2 the listed user's own memberships vs the caller's — a subset / one loja
 *      the caller does not hold
 *   A3 `x-unit-id` — one held loja / the other
 *   A4 the filtered set — populated / empty
 *   A5 seeded insertion order vs alphabetical — reversed, one accented name
 *
 * Outputs
 *   O1 one row per visible user, ordered by name
 *   O2 a user sharing no loja is absent
 *   O3 a listed row carries the user's COMPLETE membership set
 *   O4 the row's key set is exactly id, email, name, unitIds
 *   O5 an empty array for an empty filter
 *
 * Decision / branch map
 *   handler `request.crmUnitIds ?? []` — contract-hidden: the hook assigns the
 *     array before any route runs and 403s a caller with none.
 *   `units: { some: { unitId: { in } } }` — T for the listed users, F for the
 *     stranger; `in: []` matches none.
 *
 * Out of scope: 401/403 (the hook); creating users and replacing memberships
 *   (create-user, set-user-units); which collation the server uses.
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
import { listUsers, route } from "../index.js";

/** The caller's own display name; sorts after the colleagues so the ordering case stays legible. */
const CALLER_NAME = "Zuleica Atendente";

const db = () => prisma as PrismaClient;

/** A unique e-mail per run: `user.email` is globally unique and other transactions run in parallel. */
function email(local: string): string {
  return `${local}-${randomUUID().slice(0, 8)}@test.local`;
}

/**
 * Seeds three lojas, the caller on the first two, and four colleagues.
 *
 * Colleagues are inserted against alphabetical order, so a query returning
 * insertion order cannot pass the ordering case by accident.
 *
 * @param tx - The test transaction.
 * @returns The three loja ids, the caller's id and the colleagues' ids.
 */
async function seedTeam(tx: DbClient) {
  const a = (await seedUnit(tx, { name: "Loja Norte" })).id;
  const b = (await seedUnit(tx, { name: "Loja Centro" })).id;
  const c = (await seedUnit(tx, { name: "Loja Sul" })).id;

  const bruno = await seedUser(tx, { units: [b, c], email: email("bruno"), name: "Bruno Dias" });
  const avila = await seedUser(tx, { units: [b], email: email("avila"), name: "Ávila Souza" });
  const ana = await seedUser(tx, { units: [a], email: email("ana"), name: "Ana Lima" });
  const carla = await seedUser(tx, { units: [c], email: email("carla"), name: "Carla Reis" });
  const caller = await seedUser(tx, { units: [a, b], email: email("caller"), name: CALLER_NAME });

  return {
    units: { a, b, c },
    callerId: caller.id,
    ids: { bruno: bruno.id, avila: avila.id, ana: ana.id, carla: carla.id },
  };
}

type Row = { id: string; email: string; name: string; unitIds: string[] };

/**
 * Drives `GET /users` as a caller holding lojas A and B, scoped to `unitId`.
 *
 * @param tx - The test transaction.
 * @param team - From {@link seedTeam}.
 * @param unitId - The loja the request is scoped to.
 * @returns The raw response.
 */
async function get(tx: DbClient, team: Awaited<ReturnType<typeof seedTeam>>, unitId: string) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "accounts", "list-users", route),
    caller: { userId: team.callerId, unitId, unitIds: [team.units.a, team.units.b] },
  });
  try {
    return await app.inject({ method: "GET", url: "/users" });
  } finally {
    await app.close();
  }
}

/**
 * Calls the query directly, under the module's role.
 *
 * @param tx - The test transaction.
 * @param visible - The filter.
 * @returns The rows.
 */
function query(tx: DbClient, visible: string[]) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("accounts", (t) => listUsers(t, visible));
}

describeWithDatabase("GET /users", () => {
  it("lists every user sharing a loja with the caller, ordered by name", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const response = await get(tx, team, team.units.a);

      expect(response.statusCode).toBe(200);
      expect(response.json().map((row: Row) => row.name)).toEqual([
        "Ana Lima",
        "Ávila Souza",
        "Bruno Dias",
        CALLER_NAME,
      ]);
    }));

  it("leaves out a user who shares no loja with the caller", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const response = await get(tx, team, team.units.a);

      const listed = response.json().map((row: Row) => row.id);
      expect(listed).not.toContain(team.ids.carla);
      // Carla exists and belongs to a loja; she is filtered, not missing.
      expect(
        await tx.userUnit.count({ where: { userId: team.ids.carla, unitId: team.units.c } }),
      ).toBe(1);
    }));

  it("returns the same team whichever loja the x-unit-id header selects", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const first = await get(tx, team, team.units.a);
      const second = await get(tx, team, team.units.b);

      expect(second.json()).toEqual(first.json());
    }));

  it("carries a listed user's complete membership set, including a loja the caller does not hold", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const response = await get(tx, team, team.units.a);

      const bruno = response.json().find((row: Row) => row.id === team.ids.bruno);
      // A set, not a sequence: the nested `units` select carries no orderBy.
      expect([...bruno.unitIds].sort()).toEqual([team.units.b, team.units.c].sort());
      // And the caller genuinely does not hold unit C, so the line above is the
      // complete-membership rule rather than the shared-loja one.
      expect(
        await tx.userUnit.count({ where: { userId: team.callerId, unitId: team.units.c } }),
      ).toBe(0);
    }));

  it("carries no field beyond the identifier, e-mail, name and units", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const response = await get(tx, team, team.units.a);

      const row = response.json()[0];
      expect(Object.keys(row).sort()).toEqual(["email", "id", "name", "unitIds"]);
      expect(row).not.toHaveProperty("password");
    }));
});

describeWithDatabase("listUsers", () => {
  it("lists every user sharing a held loja, ordered by name", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const rows = await query(tx, [team.units.b, team.units.a]);

      expect(rows.map((row) => row.name)).toEqual([
        "Ana Lima",
        "Ávila Souza",
        "Bruno Dias",
        CALLER_NAME,
      ]);
    }));

  it("leaves out a user whose only loja the caller does not hold", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const rows = await query(tx, [team.units.b, team.units.a]);

      expect(rows.map((row) => row.id)).not.toContain(team.ids.carla);
    }));

  it("carries a listed user's whole membership set, not only the shared part", () =>
    withTestTransaction(db(), async (tx) => {
      const team = await seedTeam(tx);

      const rows = await query(tx, [team.units.b, team.units.a]);

      const bruno = rows.find((row) => row.id === team.ids.bruno);
      // Compared as a set: no orderBy governs the nested rows.
      expect([...(bruno?.unitIds ?? [])].sort()).toEqual([team.units.b, team.units.c].sort());
    }));

  it("matches no user when the caller holds no loja", () =>
    withTestTransaction(db(), async (tx) => {
      await seedTeam(tx);

      const rows = await query(tx, []);

      expect(rows).toEqual([]);
    }));
});
