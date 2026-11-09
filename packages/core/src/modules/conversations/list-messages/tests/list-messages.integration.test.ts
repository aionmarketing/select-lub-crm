/**
 * Test design (testing-strategy) — conversations / list-messages
 *
 * Module role: `module_conversations`. The loja check, the message read and the
 * outbox read run in one `db.tx("conversations", …)`.
 *
 * Moved from `apps/api/src/conversations.test.ts` (4A), assertions unchanged:
 * its three thread cases. The unknown-id 404 shares its case with the send
 * route and stays on the whole app in
 * `apps/api/test/conversations.integration.test.ts`.
 *
 * SUT: `GET /conversations/:id/messages`, through `buildSliceApp` with this
 *   slice's route only, inside one rolling-back transaction.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md): thread ordered by
 *   providerTimestamp (WhatsApp time); HTML-like text returned unchanged (not
 *   interpreted as markup).
 *
 * Partitions
 *   P4 thread textBody is the raw HTML-like string
 *   P5 thread order is providerTimestamp, not insert order
 *   P15 a seeded outbound keeps providerStatus / contentUnavailable; an inbound
 *       without them omits invented status
 *
 * Limits: insert order is the reverse of WhatsApp time (P5).
 */
import { expect, it } from "vitest";
import { conversationMessageListSchema } from "../../contracts/http.js";
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
import { route } from "../index.js";

const db = () => prisma as PrismaClient;

type Msg = {
  direction: "inbound" | "outbound";
  textBody?: string | null;
  providerTimestamp: Date;
  providerStatus?: string | null;
  contentUnavailable?: boolean;
};

async function addMessages(tx: DbClient, conversationId: string, messages: readonly Msg[]) {
  let index = 0;
  for (const message of messages) {
    await tx.message.create({
      data: {
        conversationId,
        externalMessageId: `t-msg-${conversationId}-${index}`,
        direction: message.direction,
        messageType: "text",
        textBody: message.textBody ?? null,
        providerTimestamp: message.providerTimestamp,
        providerStatus: message.providerStatus ?? null,
        contentUnavailable: message.contentUnavailable ?? false,
      },
    });
    index += 1;
  }
}

/** One loja, one connection, one conversation, and an app scoped to the loja. */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "list-messages", route),
    caller: { userId: "messages-test-caller", unitId: unit.id },
  });
  const thread = () => app.inject({ method: "GET", url: `/conversations/${conversation.id}/messages` });
  return { conversation, app, thread };
}

describeWithDatabase("GET /conversations/:id/messages", () => {
  it("returns HTML-like text unchanged", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, thread } = await setup(tx);
      const markup = "<img src=x onerror=alert(1)>";
      await addMessages(tx, conversation.id, [
        { direction: "inbound", textBody: markup, providerTimestamp: new Date("2026-01-01T00:00:00.000Z") },
      ]);

      const messages = await thread();
      expect(messages.statusCode).toBe(200);
      expect(messages.json()[0]?.textBody).toBe(markup);
      await app.close();
    }));

  it("returns messages in providerTimestamp order when ingest order is reversed", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, thread } = await setup(tx);
      await addMessages(tx, conversation.id, [
        {
          direction: "inbound",
          textBody: "chegou primeiro no CRM",
          providerTimestamp: new Date("2026-08-26T18:00:00.000Z"),
        },
        {
          direction: "inbound",
          textBody: "hora WhatsApp mais antiga",
          providerTimestamp: new Date("2026-08-26T12:00:00.000Z"),
        },
      ]);

      const response = await thread();
      expect(response.statusCode).toBe(200);
      expect(response.json().map((row: { textBody: string }) => row.textBody)).toEqual([
        "hora WhatsApp mais antiga",
        "chegou primeiro no CRM",
      ]);
      await app.close();
    }));

  it("returns providerStatus on a seeded outbound and omits it on inbound", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversation, app, thread } = await setup(tx);
      await addMessages(tx, conversation.id, [
        { direction: "inbound", textBody: "oi", providerTimestamp: new Date("2026-08-26T12:00:00.000Z") },
        {
          direction: "outbound",
          textBody: "resposta",
          providerTimestamp: new Date("2026-08-26T12:01:00.000Z"),
          providerStatus: "delivered",
          contentUnavailable: true,
        },
      ]);

      const response = await thread();
      expect(response.statusCode).toBe(200);
      const body = conversationMessageListSchema.parse(response.json());
      expect(body).toHaveLength(2);
      expect(body[0]).not.toHaveProperty("providerStatus");
      expect(body[0]).not.toHaveProperty("contentUnavailable");
      expect(body[1]).toMatchObject({ direction: "outbound", providerStatus: "delivered", contentUnavailable: true });
      await app.close();
    }));
});
