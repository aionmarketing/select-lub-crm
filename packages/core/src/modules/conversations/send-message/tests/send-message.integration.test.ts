/**
 * Test design (testing-strategy) — conversations / send-message
 *
 * Module role: `module_conversations` for the loja check; the outbox row is
 * written by channel's `enqueueOutbound` under `module_channel`. The probe is
 * awaited between the two, inside neither transaction (W2-C12).
 *
 * Moved from `apps/api/src/conversations.test.ts` (4A), assertions unchanged:
 * the whitespace 400, the live-probe 409 and the two idempotency cases; and
 * from `conversations.media.test.ts`, its empty-JSON text case. "queues
 * a non-empty send" reads the result back through the thread route, and the
 * connectivity-split and unknown-id cases span routes; those three stay on the
 * whole app in `apps/api/test/conversations.integration.test.ts`.
 *
 * SUT: `POST /conversations/:id/messages`, through `buildSliceApp` with this
 *   slice's route only, inside one rolling-back transaction, with the LIVE
 *   probe a function the test controls.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md): send goes through the outbox.
 *   Empty text → 400. Channel down (the LIVE probe) → 409.
 *
 * WHAT ONLY HELD ON THE FAKE (from the original file): connectivity has two
 *   sources. The send reads the LIVE probe; the stored column never decides it.
 *   The 409 case holds the column CONNECTED (the seeded default) and moves only
 *   the probe.
 *
 * Partitions
 *   P6 send text "  " → 400, zero outbox rows (trim then min(1) fails)
 *   P8 probe says disconnected → 409, zero outbox rows
 *   O9 one outbox row when two sends share an idempotencyKey
 *   O10 two outbox rows when the key is omitted
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
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { createRoute } from "../index.js";

const db = () => prisma as PrismaClient;

function outboxCount(tx: DbClient, conversationId: string) {
  return tx.outboxMessage.count({ where: { conversationId } });
}

/** One loja, one CONNECTED connection, one conversation, and an app over the given probe. */
async function setup(tx: DbClient, connected = true) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) =>
      registerSlice(app, "conversations", "send-message", createRoute({ channelConnected: async () => connected })),
    caller: { userId: "send-test-caller", unitId: unit.id },
  });
  const send = (payload: { text: string; idempotencyKey?: string }) =>
    app.inject({ method: "POST", url: `/conversations/${conversation.id}/messages`, payload });
  return { conversation, app, send };
}

describeWithDatabase("POST /conversations/:id/messages", () => {
  it("rejects whitespace-only send", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, send } = await setup(tx);

      const empty = await send({ text: "  " });

      expect(empty.statusCode).toBe(400);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("still rejects empty JSON text with no file on the text POST", () =>
    withTestTransaction(db(), async (tx) => {
      // Moved from `conversations.media.test.ts`: the text POST is untouched by
      // the multipart media route beside it.
      const { conversation, app, send } = await setup(tx);

      const response = await send({ text: "  " });

      expect(response.statusCode).toBe(400);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("returns 409 when the live probe says the channel is down", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, send } = await setup(tx, false);

      const down = await send({ text: "depois" });

      expect(down.statusCode).toBe(409);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("reuses one outbox row when two send-text calls share an idempotencyKey", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, send } = await setup(tx);
      // Generated, not literal: `OutboxMessage.idempotencyKey` is globally
      // unique, so a fixed string would collide with any concurrent file.
      const key = `t-send-${conversation.id}`;

      const first = await send({ text: "oi", idempotencyKey: key });
      const second = await send({ text: "oi de novo", idempotencyKey: key });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      expect(await outboxCount(tx, conversation.id)).toBe(1);
      await app.close();
    }));

  it("creates two outbox rows when send-text omits idempotencyKey", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, send } = await setup(tx);

      await send({ text: "um" });
      await send({ text: "dois" });

      expect(await outboxCount(tx, conversation.id)).toBe(2);
      await app.close();
    }));
});
