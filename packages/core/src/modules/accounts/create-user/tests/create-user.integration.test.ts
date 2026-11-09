/**
 * Test design (testing-strategy) — accounts / create-user
 *
 * Module role: `module_accounts`. The CRM insert and the memberships run
 * inside one `db.tx("accounts", …)`, so both ran as that role. The Supabase
 * call is a port, stubbed inline, and runs outside the transaction.
 *
 * Moved from `apps/api/src/auth.test.ts`, assertions kept:
 *   - "returns 409 when POST /users repeats an e-mail"
 *   - "returns 409 when Auth reports a duplicate e-mail before the CRM insert"
 *   - "isAuthDuplicateEmail", four rows, now against `rules.ts`
 * The create half of the create → attach → detach flow stays in
 * `apps/api/test/accounts.integration.test.ts`: what it proves is the hook
 * admitting the created user to one loja and not another.
 *
 * ONE ASSERTION RESTORED. In `auth.test.ts` the repeat-e-mail 409 had to be the
 * last statement, because the unique violation aborted the enclosing test
 * transaction; the "no second row" check was pushed out to
 * `apps/api/src/auth.users.live.test.ts`, on committed rows. Here the insert
 * runs inside `db.tx`, whose savepoint is rolled back on failure
 * (`kernel/db.ts`), so the test transaction survives the 409 and the check
 * after it can be made again: exactly one row for the e-mail, and no row for the
 * second provider id. The live file keeps its committed-row version.
 *
 * New here: the 201 itself (rows written, key set), and the rollback when an
 * initial loja does not exist — no `user` row is left without memberships.
 *
 * Setup: `buildSliceApp` with accounts' create-user route, built by
 * `createRoute` over an inline `createAuthUser` stub, inside one rolling-back
 * transaction per test (`withTestTransaction`). Every e-mail is unique per run:
 * `user.email` is globally unique and files run in parallel.
 *
 * Oracle: openspec/changes/auth-unit-matrix specs/auth — an admin creates a
 *   user with initial units; schema-review-hardening auth delta — POST /users
 *   with an e-mail that already has a CRM User row is 409 and the user table
 *   still has one row for that e-mail.
 *
 * Decision map (createHandler)
 *   createAuthUser duplicate T: Auth-exists 409 it; F: every other it
 *   createAuthUser other throw — rethrown, Fastify 500; no product scenario
 *   CRM insert unique violation T: repeat-email 409 it; F: 201 it
 *   CRM write other throw T: ghost-loja it (500, nothing left); F: 201 it
 *   unitIds omitted — `?? []` T: repeat-email it; F: 201 it
 *
 * Out of scope: 401 (the hook); live Supabase; compensating the Auth user when
 *   the CRM write fails (recorded in AGENTS.md, unchanged from apps/api).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { createRoute, type CreateUserPorts } from "../index.js";
import { isAuthDuplicateEmail } from "../rules.js";

const db = () => prisma as PrismaClient;

/** A unique e-mail per run. */
function email(local: string): string {
  return `${local}-${randomUUID().slice(0, 8)}@test.local`;
}

/**
 * Builds an app carrying only this slice over `createAuthUser`.
 *
 * @param tx - The test transaction.
 * @param createAuthUser - The provider stub.
 * @returns The app and a `post` helper; the test closes the app.
 */
async function appOn(tx: DbClient, createAuthUser: CreateUserPorts["createAuthUser"]) {
  const caller = await seedUser(tx, { units: [], email: email("attendant"), name: "Atendente" });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "accounts", "create-user", createRoute({ createAuthUser })),
    caller: { userId: caller.id, unitIds: [] },
  });
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/users",
      headers: { "content-type": "application/json" },
      payload,
    });
  return { app, post };
}

describeWithDatabase("POST /users", () => {
  it("creates the CRM user with its initial lojas and answers 201", () =>
    withTestTransaction(db(), async (tx) => {
      const a = (await seedUnit(tx)).id;
      const createdId = randomUUID();
      const createdEmail = email("novo");
      const { app, post } = await appOn(tx, async () => ({ id: createdId }));

      const response = await post({
        email: createdEmail,
        password: "secret",
        name: "Novo",
        unitIds: [a],
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: createdId, email: createdEmail, name: "Novo", unitIds: [a] });
      expect(JSON.stringify(response.json())).not.toContain("secret");
      expect(await tx.user.count({ where: { id: createdId, email: createdEmail } })).toBe(1);
      expect(await tx.userUnit.count({ where: { userId: createdId, unitId: a } })).toBe(1);
      await app.close();
    }));

  it("returns 409 when POST /users repeats an e-mail", () =>
    withTestTransaction(db(), async (tx) => {
      const ids = [randomUUID(), randomUUID()];
      const duplicated = email("dup");
      let n = 0;
      const { app, post } = await appOn(tx, async () => ({ id: ids[n++]! }));

      const first = await post({ email: duplicated, password: "secret", name: "Um" });
      expect(first.statusCode).toBe(201);
      expect(await tx.user.count({ where: { id: ids[0]!, email: duplicated } })).toBe(1);
      expect(await tx.user.count({ where: { id: ids[1]! } })).toBe(0);

      const second = await post({ email: duplicated, password: "secret", name: "Dois" });

      expect(second.statusCode).toBe(409);
      // Restored (see header): the refusal rolled back to db.tx's savepoint, so
      // the test transaction is still usable and the table can be read.
      expect(await tx.user.count({ where: { email: duplicated } })).toBe(1);
      expect(await tx.user.count({ where: { id: ids[1]! } })).toBe(0);
      await app.close();
    }));

  it("returns 409 when Auth reports a duplicate e-mail before the CRM insert", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, post } = await appOn(tx, async () => {
        const error = new Error("User already registered");
        Object.assign(error, { code: "email_exists", status: 422 });
        throw error;
      });
      const refused = email("exists");

      const response = await post({ email: refused, password: "secret", name: "X" });

      // Auth refuses before any CRM insert, so nothing writes.
      expect(response.statusCode).toBe(409);
      expect(response.statusCode).not.toBe(500);
      expect(await tx.user.count({ where: { email: refused } })).toBe(0);
      await app.close();
    }));

  // Found in review: `[a, a]` hit user_unit's (user, unit) primary key, and the
  // handler reported that P2002 as 409 "e-mail taken" for an e-mail nobody had.
  it("creates the user once with a loja named twice, instead of answering 409", () =>
    withTestTransaction(db(), async (tx) => {
      const a = (await seedUnit(tx)).id;
      const createdId = randomUUID();
      const createdEmail = email("repetido");
      const { app, post } = await appOn(tx, async () => ({ id: createdId }));

      const response = await post({
        email: createdEmail,
        password: "secret",
        name: "Repetido",
        unitIds: [a, a],
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().unitIds).toEqual([a]);
      expect(await tx.user.count({ where: { id: createdId, email: createdEmail } })).toBe(1);
      expect(await tx.userUnit.count({ where: { userId: createdId } })).toBe(1);
      await app.close();
    }));

  it("leaves no user row behind when an initial loja does not exist", () =>
    withTestTransaction(db(), async (tx) => {
      const createdId = randomUUID();
      const createdEmail = email("orfao");
      const ghost = "unit-ghost-create-user";
      expect(await tx.unit.count({ where: { id: ghost } })).toBe(0);
      const { app, post } = await appOn(tx, async () => ({ id: createdId }));

      const response = await post({
        email: createdEmail,
        password: "secret",
        name: "Órfão",
        unitIds: [ghost],
      });

      expect(response.statusCode).toBe(500);
      // The insert of the user ran before the membership failed; one db.tx
      // rolled both back, so no user exists without its lojas.
      expect(await tx.user.count({ where: { id: createdId } })).toBe(0);
      await app.close();
    }));
});

// Pure predicate: no database, so it stays an ordinary describe.
describe("isAuthDuplicateEmail", () => {
  it.each([
    { code: "email_exists", status: 0, message: "", expected: true },
    { code: "user_already_exists", status: 0, message: "", expected: true },
    { code: "", status: 422, message: "User already registered", expected: true },
    { code: "other", status: 500, message: "boom", expected: false },
  ])("$code/$status → $expected", ({ code, status, message, expected }) => {
    expect(isAuthDuplicateEmail({ code, status, message })).toBe(expected);
  });
});
