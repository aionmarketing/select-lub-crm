/**
 * Fixture for the list-conversations tests: one loja, one connection, a member
 * user, and an app carrying this slice's route with that user as the caller —
 * plus the row writers the inbox reads.
 *
 * Moved from the helpers of `apps/api/src/conversations.test.ts` and
 * `conversations.filters.route.test.ts` (4A). `addMessages` is the filters
 * file's version, which keeps both `lastMessageAt` and `firstInboundAt` in step
 * with the messages; the other file's kept only `lastMessageAt`, and none of its
 * cases reads `firstInboundAt`.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { conversationSummaryListSchema } from "../../contracts/http.js";
import { createDb } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
} from "@select-lub/core/testing";
import { route } from "../index.js";

/** The shared client the harness opens each test transaction on. */
export const db = () => prisma as PrismaClient;

const AUG10 = new Date("2026-08-10T12:00:00.000-03:00");

/** One message to write. */
export type Msg = {
  direction: "inbound" | "outbound";
  messageType?: string;
  textBody?: string | null;
  providerTimestamp?: Date;
  shouldReply?: boolean | null;
};

/**
 * Appends messages to a conversation and keeps the conversation's derived
 * timestamps consistent with them: the list reads `firstInboundAt` for the
 * period filter and the message rows for the snippet, the unanswered flag and
 * `hasTeamReply`, so a fixture that wrote only one would make those disagree.
 */
export async function addMessages(tx: DbClient, conversationId: string, messages: readonly Msg[]) {
  let index = 0;
  for (const message of messages) {
    await tx.message.create({
      data: {
        conversationId,
        externalMessageId: `t-msg-${conversationId}-${index}`,
        direction: message.direction,
        messageType: message.messageType ?? "text",
        textBody: message.textBody ?? null,
        providerTimestamp: message.providerTimestamp ?? AUG10,
        shouldReply: message.shouldReply ?? null,
      },
    });
    index += 1;
  }
  const inbound = messages.filter((m) => m.direction === "inbound");
  const times = messages.map((m) => (m.providerTimestamp ?? AUG10).getTime());
  if (times.length > 0) {
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(Math.max(...times)),
        ...(inbound.length > 0
          ? { firstInboundAt: new Date(Math.min(...inbound.map((m) => (m.providerTimestamp ?? AUG10).getTime()))) }
          : {}),
      },
    });
  }
}

/** A customer in the loja, optionally linked to a conversation — the row `contactLabel` and search read. */
export async function addCustomer(
  tx: DbClient,
  input: { unitId: string; name: string | null; conversationId?: string },
) {
  const customer = await tx.customer.create({
    data: { unitId: input.unitId, name: input.name, origin: "crm", status: "active" },
    select: { id: true },
  });
  if (input.conversationId) {
    await tx.conversation.update({ where: { id: input.conversationId }, data: { customerId: customer.id } });
  }
  return customer;
}

/**
 * Makes `hasQuoteSent` true: an `OilQuote` naming the conversation, which
 * cannot exist without a customer, a vehicle and an author — the same table
 * production reads.
 */
export async function addQuoteSent(tx: DbClient, input: { unitId: string; conversationId: string; userId: string }) {
  const customer = await addCustomer(tx, { unitId: input.unitId, name: "Quote customer" });
  const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm" }, select: { id: true } });
  await tx.oilQuote.create({
    data: {
      customerId: customer.id,
      vehicleId: vehicle.id,
      conversationId: input.conversationId,
      generatedMessageText: "orçamento",
      createdByUserId: input.userId,
    },
  });
}

/** Makes `hasServiceAttributed` true: a Service in the loja attributed to the conversation. */
export async function addServiceAttributed(tx: DbClient, input: { unitId: string; conversationId: string }) {
  const customer = await addCustomer(tx, { unitId: input.unitId, name: "Service customer" });
  const service = await tx.service.create({
    data: { customerId: customer.id, unitId: input.unitId, origin: "omie" },
    select: { id: true },
  });
  await tx.serviceConversationAttribution.create({
    data: { serviceId: service.id, conversationId: input.conversationId, ruleVersion: 1 },
  });
}

/** An app with this slice's route, called by `userId` scoped to `unitId`. */
export function listApp(tx: DbClient, caller: { userId: string; unitId: string }) {
  return buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (app) => registerSlice(app, "conversations", "list-conversations", route),
    caller,
  });
}

/** One loja, one connection, a member user, and an app scoped to them. */
export async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const user = await seedUser(tx, { units: [unit.id] });
  const app = await listApp(tx, { userId: user.id, unitId: unit.id });
  return { unit, connection, user, app };
}

/** `GET /conversations` with a query string (`""` for none). */
export function listIds(app: Awaited<ReturnType<typeof listApp>>, query: string) {
  return app.inject({ method: "GET", url: `/conversations${query}` });
}

/** The ids of a list response, parsed through the contract. */
export function idsOf(response: { json: () => unknown }) {
  return conversationSummaryListSchema.parse(response.json()).map((row) => row.id);
}
