/**
 * Test design (testing-strategy) — accounts at the composition root
 *
 * WHY THIS FILE IS IN apps/api AND NOT IN A SLICE
 *   The subject of every case here is `apps/api`'s auth hook, or the hook and
 *   an accounts route together: 401 without a token, 403 on a unit the caller
 *   is not in, and a created user's memberships deciding what the hook lets
 *   through. The hook stays in `apps/api` (wave 2 correction W2-C1), and a
 *   slice's `buildSliceApp` writes the caller onto the request instead of
 *   running it, so none of these can be asserted from a slice's `tests/`. They
 *   run through the real `buildApp`, one file per module, as ruled for wave 2.
 *   The accounts routes' own status codes and bodies moved to their slices:
 *   `GET /auth/me` → get-me, the two 409s → create-user, the 404 → set-user-units.
 *
 * Moved here, assertions unchanged:
 *   - from `apps/api/src/auth.test.ts`: the six "auth hook on conversation
 *     list" cases, the one "does not require a second user" case, and the
 *     create → attach → detach flow.
 *   - from `apps/api/src/users.route.test.ts`: its three hook cases on
 *     `GET /users` (no Authorization, unknown Bearer, header outside the
 *     memberships).
 *   - from `apps/api/src/units.route.test.ts`: its two hook cases on
 *     `GET /units` (no Authorization, header outside the memberships). The 401
 *     guards `/units` staying in `API_PATH_PREFIXES`: a GET path missing there
 *     skips JWT validation instead of refusing.
 *   - from `apps/api/src/users.units.live.test.ts`: its two "served by the
 *     adapter buildApp chose" cases, now "served by the plugin buildApp
 *     registered". They ran on committed rows and read them back through the
 *     same client; nothing depended on a second connection seeing them, so
 *     they run here in the rolling-back transaction.
 *   The caller reads the hook makes now run under `module_accounts`
 *   (`createCallerDirectory`), and so do the `/users` and `/units` reads; the
 *   conversation list reads run under `module_conversations` (4A).
 *
 * Setup: Fastify inject against the real Prisma adapters inside one
 * rolling-back transaction per test (`withTestTransaction`) on the worktree
 * database. The caller is a real `user` row with real `user_unit` memberships
 * seeded by `seedUser`. `getUser` and `createAuthUser` stay injected: they are
 * external ports (Supabase), not stores.
 *
 * **The channel probe is pinned, so no test here can reach the real instance.**
 * `buildApp` wires `channelConnected: () => fetchEvolutionConnected()`, and this
 * app's Vitest setup loads the repo `.env`, so `SERVER_URL` and
 * `AUTHENTICATION_API_KEY` are set and any channel-state request would go out to
 * the hosted Evolution instance (memory:
 * buildapp-channel-probe-calls-evolution-live). The app is therefore built here
 * with an explicit `channelConnected` and this test's own instance name, through
 * `buildApp`'s `channelConnected` and `evolutionInstanceName` ports. Passing the
 * name also keeps the file from reading `EVOLUTION_INSTANCE_NAME` or repointing
 * the shared connection row.
 *
 * Every row read here is created here, inside the transaction, so the file is
 * unaffected by whether the database it runs against was seeded.
 *
 * Oracle: openspec/changes/auth-unit-matrix specs/auth Axis 1
 *   Missing/invalid token → 401 and not a conversation list.
 *   Own unit → 200 only that unit. Other unit → 403 and no B rows.
 *   Zero memberships → 403. One membership omit header → 200 that unit.
 *
 * Axes
 *   A1 token — missing / invalid / valid
 *   A2 membership vs header — own / foreign / zero / one-omit
 *
 * Outputs
 *   O1 401; O2 200 list of unit A; O3 403 and not B's rows
 *
 * Sampled-cell
 *   no Authorization           | A1 miss | O1 | 200 list
 *   invalid token              | A1 bad  | O1 | 200
 *   valid + own unit           | A2 own  | O2 | B's phone in body
 *   valid + other unit         | A2 foreign | O3 | 200 with B
 *   valid + zero memberships   | A2 zero | O3 | 200 []
 *   valid + one membership omit| A2 omit | O2 | 401/403
 *
 * Decision map (registerAuthHook)
 *   D1 health skip T: spa.integration.test.ts; F: this file's routes
 *   D2 !token T: no Authorization; F: invalid/valid
 *   D3 getUser null T: invalid token; F: valid
 *   D4 resolveCurrentUnit null T: foreign + zero; F: own + omit
 *
 * Out of scope: live Supabase `getUser`; the committed duplicate-row count
 *   (`apps/api/src/auth.users.live.test.ts`); each accounts route's own
 *   answers (its slice's `tests/`).
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeCreateAuthUser } from "@select-lub/core/modules/accounts";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";
import { TEST_ACCESS_TOKEN, TEST_USER_ID, createFakeGetUser } from "@select-lub/core/testing";

const otherToken = "other-access-token";
const otherUserId = "22222222-2222-2222-2222-222222222222";

const db = () => prisma as PrismaClient;

/** A unique e-mail per run: `user.email` is globally unique and files run in parallel. */
function email(local: string): string {
  return `${local}-${randomUUID().slice(0, 8)}@test.local`;
}

/**
 * Creates a loja with its own WhatsApp connection.
 *
 * A conversation reaches its unit only through the connection, so a test that
 * needs two units needs two connections.
 *
 * @param tx - The test transaction.
 * @returns The unit id, the connection id and the connection's instance name.
 */
async function seedLoja(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  return { unitId: unit.id, connectionId: connection.id, instanceName: connection.instanceName };
}

/**
 * Creates one conversation whose `chatKey` is the phone the list route returns.
 *
 * @param tx - The test transaction.
 * @param connectionId - Connection the conversation hangs off; its unit is the
 *   conversation's unit.
 * @param phone - Digits, stored as `chatKey` and echoed back as `phone`.
 * @returns The conversation id.
 */
async function seedChat(tx: DbClient, connectionId: string, phone: string): Promise<string> {
  const at = new Date("2026-08-10T12:00:00.000Z");
  const row = await tx.conversation.create({
    data: {
      whatsappConnectionId: connectionId,
      remoteJid: `${phone}@s.whatsapp.net`,
      chatKey: phone,
      startedAt: at,
      firstInboundAt: at,
      lastMessageAt: at,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Builds the app on the test transaction with the channel probe pinned.
 *
 * @param tx - The test transaction.
 * @param options.instanceName - Instance the app resolves (`evolutionInstanceName`); this
 *   test's own connection, never the shared one named by the environment.
 * @param options.getUser - Token validator; defaults to the standard fake.
 * @param options.createAuthUser - Supabase Auth Admin stub, when the test posts users.
 * @returns A Fastify app for `inject()`.
 */
async function appOn(
  tx: DbClient,
  options: {
    instanceName?: string;
    getUser?: ReturnType<typeof createFakeGetUser>;
    createAuthUser?: Parameters<typeof buildApp>[0]["createAuthUser"];
  } = {},
) {
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: options.getUser ?? createFakeGetUser(),
    ...(options.createAuthUser ? { createAuthUser: options.createAuthUser } : {}),
    evolutionInstanceName: options.instanceName ?? `t-auth-${randomUUID().slice(0, 8)}`,
    channelConnected: async () => true,
  });
}

describeWithDatabase("auth hook on conversation list", () => {
  it("returns 401 when the conversation list has no access token", () =>
    withTestTransaction(db(), async (tx) => {
      const loja = await seedLoja(tx);
      await seedUser(tx, { id: TEST_USER_ID, units: [loja.unitId], email: email("attendant") });
      const app = await appOn(tx, { instanceName: loja.instanceName });

      const response = await app.inject({ method: "GET", url: "/conversations" });

      expect(response.statusCode).toBe(401);
      expect(Array.isArray(response.json())).toBe(false);
      await app.close();
    }));

  it("returns 401 when getUser rejects the token", () =>
    withTestTransaction(db(), async (tx) => {
      const loja = await seedLoja(tx);
      await seedUser(tx, { id: TEST_USER_ID, units: [loja.unitId], email: email("attendant") });
      const app = await appOn(tx, {
        instanceName: loja.instanceName,
        getUser: createFakeGetUser({ bad: null }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: "Bearer bad", "x-unit-id": loja.unitId },
      });

      expect(response.statusCode).toBe(401);
      await app.close();
    }));

  it("lists only the caller's unit when the token and header match a membership", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedLoja(tx);
      const lojaB = await seedLoja(tx);
      await seedChat(tx, lojaA.connectionId, "11911110000");
      const foreign = await seedChat(tx, lojaB.connectionId, "11922220000");
      await seedUser(tx, { id: TEST_USER_ID, units: [lojaA.unitId], email: email("attendant") });
      const app = await appOn(tx, { instanceName: lojaA.instanceName });

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, "x-unit-id": lojaA.unitId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as Array<{ phone: string }>;
      expect(body.map((row) => row.phone)).toEqual(["11911110000"]);
      // The other unit's row exists and is reachable, so the single entry above
      // is the tenancy join excluding it rather than the row being absent.
      const stored = await tx.conversation.findUniqueOrThrow({
        where: { id: foreign },
        select: { chatKey: true, whatsappConnection: { select: { unitId: true } } },
      });
      expect(stored.chatKey).toBe("11922220000");
      expect(stored.whatsappConnection.unitId).toBe(lojaB.unitId);
      await app.close();
    }));

  it("returns 403 and no other-unit rows when the header is not a membership", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedLoja(tx);
      const lojaB = await seedLoja(tx);
      await seedChat(tx, lojaB.connectionId, "11922220000");
      await seedUser(tx, { id: TEST_USER_ID, units: [lojaA.unitId], email: email("attendant") });
      const app = await appOn(tx, { instanceName: lojaA.instanceName });

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, "x-unit-id": lojaB.unitId },
      });

      expect(response.statusCode).toBe(403);
      const body: unknown = response.json();
      expect(JSON.stringify(body)).not.toContain("11922220000");
      await app.close();
    }));

  it("returns 403 when a verified user has zero memberships", () =>
    withTestTransaction(db(), async (tx) => {
      await seedLoja(tx);
      await seedUser(tx, { id: TEST_USER_ID, units: [], email: email("attendant") });
      const app = await appOn(tx);

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      await app.close();
    }));

  it("uses the sole membership when the unit header is omitted", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedLoja(tx);
      await seedChat(tx, lojaA.connectionId, "11911110000");
      await seedUser(tx, { id: TEST_USER_ID, units: [lojaA.unitId], email: email("attendant") });
      const app = await appOn(tx, { instanceName: lojaA.instanceName });

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0]?.phone).toBe("11911110000");
      await app.close();
    }));
});

describeWithDatabase("auth hook does not require a second user for isolation", () => {
  it("still 403s when a different Auth id has no membership on unit A", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedLoja(tx);
      await seedChat(tx, lojaA.connectionId, "11911110000");
      await seedUser(tx, { id: otherUserId, units: [], email: email("b"), name: "B" });
      const app = await appOn(tx, {
        instanceName: lojaA.instanceName,
        getUser: createFakeGetUser({
          [otherToken]: { id: otherUserId, email: "b@example.com" },
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${otherToken}`, "x-unit-id": lojaA.unitId },
      });

      expect(response.statusCode).toBe(403);
      await app.close();
    }));
});

describeWithDatabase("admin create user and attach units", () => {
  it("lets the created user list unit A, forbids B, and forbids A after detach", () =>
    withTestTransaction(db(), async (tx) => {
      const lojaA = await seedLoja(tx);
      const lojaB = await seedLoja(tx);
      await seedChat(tx, lojaA.connectionId, "11911110000");
      await seedChat(tx, lojaB.connectionId, "11922220000");
      const createdId = "33333333-3333-3333-3333-333333333333";
      const createdToken = "created-access-token";
      const createdEmail = email("novo");
      await seedUser(tx, {
        id: TEST_USER_ID,
        units: [lojaA.unitId],
        email: email("attendant"),
        name: "Atendente",
      });
      const app = await appOn(tx, {
        instanceName: lojaA.instanceName,
        getUser: createFakeGetUser({
          [createdToken]: { id: createdId, email: createdEmail },
        }),
        createAuthUser: createFakeCreateAuthUser(createdId),
      });

      const created = await app.inject({
        method: "POST",
        url: "/users",
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        payload: {
          email: createdEmail,
          password: "secret",
          name: "Novo",
          unitIds: [lojaA.unitId],
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().id).toBe(createdId);
      expect(JSON.stringify(created.json())).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      // The membership is a row, not an array the test handed in.
      expect(
        await tx.userUnit.count({ where: { userId: createdId, unitId: lojaA.unitId } }),
      ).toBe(1);

      const asA = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${createdToken}`, "x-unit-id": lojaA.unitId },
      });
      expect(asA.statusCode).toBe(200);
      expect(asA.json()[0]?.phone).toBe("11911110000");

      const asB = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${createdToken}`, "x-unit-id": lojaB.unitId },
      });
      expect(asB.statusCode).toBe(403);

      const detached = await app.inject({
        method: "PUT",
        url: `/users/${createdId}/units`,
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        payload: { unitIds: [] },
      });
      expect(detached.statusCode).toBe(200);
      expect(await tx.userUnit.count({ where: { userId: createdId } })).toBe(0);

      const afterDetach = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: { authorization: `Bearer ${createdToken}`, "x-unit-id": lojaA.unitId },
      });
      expect(afterDetach.statusCode).toBe(403);
      await app.close();
    }));
});

/**
 * Seeds two named lojas the caller holds, a third they do not, and one
 * colleague on the first loja.
 *
 * Names are inserted against alphabetical order, so a list in insertion order
 * cannot pass the ordering assertions by accident.
 *
 * @param tx - The test transaction.
 * @returns The three loja ids.
 */
async function seedTeamAndLojas(tx: DbClient) {
  const a = (await seedUnit(tx, { name: "Loja Norte" })).id;
  const b = (await seedUnit(tx, { name: "Loja Centro" })).id;
  const c = (await seedUnit(tx, { name: "Loja Sul" })).id;
  await seedUser(tx, { units: [a], email: email("ana"), name: "Ana Lima" });
  await seedUser(tx, { id: TEST_USER_ID, units: [a, b], email: email("caller"), name: "Zuleica Atendente" });
  return { a, b, c };
}

/** Bearer for the standard fake caller, scoped to `unitId`. */
function scopedTo(unitId: string) {
  return { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
}

describeWithDatabase("auth hook on the accounts reads", () => {
  it("refuses GET /users with no Authorization header", () =>
    withTestTransaction(db(), async (tx) => {
      const { a } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/users", headers: { "x-unit-id": a } });

      expect(response.statusCode).toBe(401);
      await app.close();
    }));

  it("refuses GET /users with a Bearer the validator does not recognise", () =>
    withTestTransaction(db(), async (tx) => {
      const { a } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({
        method: "GET",
        url: "/users",
        headers: { "x-unit-id": a, authorization: "Bearer not-a-real-token" },
      });

      expect(response.statusCode).toBe(401);
      await app.close();
    }));

  it("refuses GET /users with a header naming a loja outside the caller's memberships", () =>
    withTestTransaction(db(), async (tx) => {
      const { c } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/users", headers: scopedTo(c) });

      expect(response.statusCode).toBe(403);
      await app.close();
    }));

  it("refuses GET /units with no Authorization header", () =>
    withTestTransaction(db(), async (tx) => {
      const { a } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/units", headers: { "x-unit-id": a } });

      expect(response.statusCode).toBe(401);
      await app.close();
    }));

  it("refuses GET /units with a header naming a loja outside the caller's memberships", () =>
    withTestTransaction(db(), async (tx) => {
      const { c } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/units", headers: scopedTo(c) });

      expect(response.statusCode).toBe(403);
      await app.close();
    }));
});

describeWithDatabase("the hook's caller read", () => {
  // Every authenticated request pays for this read, so it is one transaction,
  // not one per query. `GET /auth/me` opens none of its own (it answers from the
  // fields the hook set), so every transaction counted here is the hook's.
  it("reads profile and memberships in a single transaction per request", () =>
    withTestTransaction(db(), async (tx) => {
      const { a } = await seedTeamAndLojas(tx);
      const run = runInTransactionOnTx(tx);
      let opened = 0;
      const app = await buildApp({
        db: tx,
        runInTransaction: (fn) => {
          opened += 1;
          return run(fn);
        },
        getUser: createFakeGetUser(),
        evolutionInstanceName: `t-auth-${randomUUID().slice(0, 8)}`,
        channelConnected: async () => true,
      });

      const response = await app.inject({ method: "GET", url: "/auth/me", headers: scopedTo(a) });

      expect(response.statusCode).toBe(200);
      // The read did happen: both memberships came back, so one transaction
      // carried the profile and the memberships together.
      expect((response.json() as { unitIds: string[] }).unitIds).toHaveLength(2);
      expect(opened).toBe(1);
      await app.close();
    }));
});

describeWithDatabase("accounts reads through the plugin buildApp registered", () => {
  it("serves GET /users from the plugin buildApp registered", () =>
    withTestTransaction(db(), async (tx) => {
      const { b } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/users", headers: scopedTo(b) });

      expect(response.statusCode).toBe(200);
      expect(response.json().map((row: { name: string }) => row.name)).toEqual([
        "Ana Lima",
        "Zuleica Atendente",
      ]);
      await app.close();
    }));

  it("serves GET /units from the plugin buildApp registered", () =>
    withTestTransaction(db(), async (tx) => {
      const { a, b } = await seedTeamAndLojas(tx);
      const app = await appOn(tx);

      const response = await app.inject({ method: "GET", url: "/units", headers: scopedTo(b) });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { id: b, name: "Loja Centro" },
        { id: a, name: "Loja Norte" },
      ]);
      await app.close();
    }));
});
