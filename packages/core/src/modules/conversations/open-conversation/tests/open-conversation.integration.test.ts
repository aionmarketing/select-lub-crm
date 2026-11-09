/**
 * Test design (testing-strategy) — conversations / open-conversation
 *
 * Module role: `module_conversations`. The connection read, the existing-thread
 * read and the insert each run in their own `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/conversations.test.ts` (4A), assertions unchanged:
 * "returns 409 for Nova conversa when the stored column is not CONNECTED" and
 * "returns 400 for Nova conversa with an empty phone". "POSTs Nova conversa once
 * and reopens it on a repeat phone" reads the result back through the inbox
 * list, and #102's chat-key uniqueness case does too; both stay on the whole
 * app in `apps/api/test/conversations.integration.test.ts`. The store-level
 * branches are `open-conversation.fake-client.test.ts`.
 *
 * SUT: `POST /conversations`, through `buildSliceApp` with this slice's route
 *   only, inside one rolling-back transaction, with the configured instance
 *   named by the test.
 *
 * Oracle: openspec/specs/conversations/conversas/spec.md — "POST /conversations requires that
 *   column to read CONNECTED before it creates or reopens a row". The STORED
 *   column decides Nova conversa; the live probe never does (it is not even a
 *   port of this route).
 *
 * Partitions
 *   P13 stored column DISCONNECTED → 409 `{ code: "channel_not_connected" }`, no row
 *   P14 empty phone → 400, no row
 */
import { expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;

async function setup(tx: DbClient, connectionState?: "DISCONNECTED") {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id, ...(connectionState ? { connectionState } : {}) });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(
        app,
        "conversations",
        "open-conversation",
        createRoute({ instanceName: () => connection.instanceName }),
      ),
    caller: { userId: "open-test-caller", unitId: unit.id },
  });
  return { connection, app };
}

describeWithDatabase("POST /conversations", () => {
  it("returns 409 for Nova conversa when the stored column is not CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      // The route gates on the COLUMN, not the probe — the conversas spec says so.
      // The original file first moved the probe here and got 201; the test was
      // wrong, not the route.
      const { connection, app } = await setup(tx, "DISCONNECTED");

      const response = await app.inject({ method: "POST", url: "/conversations", payload: { phone: "11999990000" } });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: "channel_not_connected" });
      expect(await tx.conversation.count({ where: { whatsappConnectionId: connection.id } })).toBe(0);
      await app.close();
    }));

  it("returns 400 for Nova conversa with an empty phone", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await setup(tx);

      const response = await app.inject({ method: "POST", url: "/conversations", payload: { phone: "   " } });

      expect(response.statusCode).toBe(400);
      expect(await tx.conversation.count({ where: { whatsappConnectionId: connection.id } })).toBe(0);
      await app.close();
    }));
});
