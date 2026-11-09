/**
 * Test design (testing-strategy)
 *
 * SUT: the services routes as `apps/api` mounts them — through `buildApp`, the
 *   auth hook and every other module's routes — for the four cases whose subject
 *   is the composition, not a slice.
 *
 * Moved from `apps/api/src/customer-services.test.ts` (adopt-modular-vertical-
 * slices 3C, W2-C9), assertions unchanged. That file's other eight cases are the
 * `list-customer-services` and `list-conversation-services` slices' own tests.
 * These four stay on the whole app because what they assert is decided there:
 *   - the 403 comes from the auth hook, before any route matches;
 *   - "no create or mutate route" is a claim about the app — no module registers
 *     `POST /customers/:id/services` or `PATCH /services/:id` — and a module's
 *     plugin alone could not show that another module does not;
 *   - the conversation list's shape is `conversations`' route (4A), asserted here
 *     because services live on their own route and never in that list.
 *
 * Setup: `describeWithDatabase` + `withTestTransaction`; every row is created
 *   inside the test's transaction and rolled back with it. The app is built with
 *   this test's instance name and a pinned channel probe, for the reasons the
 *   original file recorded: `buildApp` resolves the instance name eagerly and the
 *   resolver throws when `EVOLUTION_INSTANCE_NAME` is unset, and the default probe
 *   is a live HTTP call.
 *
 * Oracle: openspec/changes/complete-omie-integration/specs/customer-services/spec.md
 *   "Customer-scoped service HTTP is read-only".
 *
 * F3 (from the original file) — "The PATCH left the row unchanged" is read from
 *   the `service.description` column through `tx`, the only thing that can show
 *   a write did not happen.
 *
 * Sampled-cell
 *   POST with a non-membership header     | 403                    | 201
 *   POST matching loja                    | 404 (no create)        | 201
 *   PATCH a real service                  | 404, column unchanged  | 200
 *   Conversation list item has no key     | "services" absent      | key present
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { conversationSummaryListSchema } from "@select-lub/shared-types";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

function auth(unitId: string, json = false) {
  return {
    "x-unit-id": unitId,
    authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function appOn(tx: DbClient, instanceName: string) {
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    evolutionInstanceName: instanceName,
    channelConnected: async () => true,
  });
}

async function insertCustomer(
  tx: DbClient,
  input: { unitId: string | null; name?: string | null },
) {
  return tx.customer.create({
    data: {
      origin: "crm",
      status: "active",
      name: input.name ?? "Ana",
      unitId: input.unitId,
    },
    select: { id: true },
  });
}

async function insertService(
  tx: DbClient,
  input: {
    customerId: string;
    unitId: string;
    performedAt?: Date | null;
    description?: string | null;
  },
) {
  return tx.service.create({
    data: {
      customerId: input.customerId,
      unitId: input.unitId,
      // The route's contract is Omie-origin rows carrying their OS id; `omieId`
      // is unique in the schema, so each row mints its own.
      origin: "omie",
      omieId: `os-${randomUUID().slice(0, 12)}`,
      performedAt: input.performedAt ?? null,
      description: input.description ?? null,
    },
    select: { id: true, omieId: true },
  });
}

/** One loja, its connection, the test attendant, and a customer in that loja. */
async function seedScope(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const customer = await insertCustomer(tx, { unitId: unit.id });
  return {
    unitId: unit.id,
    connectionId: connection.id,
    instanceName: connection.instanceName,
    customerId: customer.id,
  };
}

describeWithDatabase("services routes on the whole app", () => {
  const db = () => prisma as PrismaClient;

  it("returns 403 when the unit header is not a membership", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const otherUnit = await seedUnit(tx);
      const app = await appOn(tx, scope.instanceName);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/customers/${scope.customerId}/services`,
          headers: auth(otherUnit.id, true),
          payload: { description: "Troca de óleo" },
        });

        // 403 from the auth hook, before any route matching — which is why this
        // is 403 where the next test's identical call is 404.
        expect(response.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for POST /customers/:id/services when the loja matches", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const app = await appOn(tx, scope.instanceName);
      try {
        // Positive control: the GET on this very path is 200, so the 404 is the
        // absence of a POST route and not an unreachable customer.
        const readable = await app.inject({
          method: "GET",
          url: `/customers/${scope.customerId}/services`,
          headers: auth(scope.unitId),
        });
        expect(readable.statusCode).toBe(200);

        const response = await app.inject({
          method: "POST",
          url: `/customers/${scope.customerId}/services`,
          headers: auth(scope.unitId, true),
          payload: { description: "Troca de óleo" },
        });

        expect(response.statusCode).toBe(404);
        expect(await tx.service.count({ where: { customerId: scope.customerId } })).toBe(0);
      } finally {
        await app.close();
      }
    }));

  it("returns 404 for PATCH /services/:id and leaves the stored description unchanged", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const service = await insertService(tx, {
        customerId: scope.customerId,
        unitId: scope.unitId,
        description: "Troca de óleo",
      });
      const app = await appOn(tx, scope.instanceName);
      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/services/${service.id}`,
          headers: auth(scope.unitId, true),
          payload: { description: "Revisão completa" },
        });

        expect(response.statusCode).toBe(404);
        // The column, through tx — the only thing that can show no write
        // happened. The old file asked the fake about its own map (F3).
        const persisted = await tx.service.findUniqueOrThrow({
          where: { id: service.id },
          select: { description: true },
        });
        expect(persisted.description).toBe("Troca de óleo");
      } finally {
        await app.close();
      }
    }));

  it("keeps conversation list items without a services key", () =>
    withTestTransaction(db(), async (tx) => {
      const scope = await seedScope(tx);
      const conversation = await seedConversation(tx, { connectionId: scope.connectionId });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: scope.customerId },
      });
      const app = await appOn(tx, scope.instanceName);
      try {
        const response = await app.inject({
          method: "GET",
          url: "/conversations",
          headers: auth(scope.unitId),
        });

        expect(response.statusCode).toBe(200);
        const list = conversationSummaryListSchema.parse(response.json());
        // This test's own row, found by id — the worktree database also holds
        // the demo seed's conversations (design D9).
        const mine = list.find((row) => row.id === conversation.id);
        expect(mine).toBeDefined();
        expect("services" in mine!).toBe(false);
      } finally {
        await app.close();
      }
    }));
});
