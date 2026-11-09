/**
 * The Follow-up queue as real rows, for the follow-up slices' tests and the
 * whole-app suite in `apps/api/test/follow-up.integration.test.ts`.
 *
 * Moved from `apps/api/src/follow-up.route.test.ts` (4A), unchanged but for one
 * parameter: the author of quotes and reminders was the api's `TEST_USER_ID`,
 * and is now `userId`, because a slice test states its own caller. Every row is
 * written through the caller's transaction, so it rolls back with the test.
 *
 * Dates are offsets from the run's own clock, far enough from the
 * today..today+14 boundaries (-10 and +7) that the America/Sao_Paulo conversion
 * cannot flip them; reminder moments are in the FUTURE to be counted as planned.
 */
import { randomUUID } from "node:crypto";
import type { DbClient } from "@select-lub/core/db";
import { seedConnection, seedConversation, seedUnit, seedUser } from "./seed.js";

/** One day in milliseconds. */
export const DAY_MS = 86_400_000;

/** The UTC midnight of the calendar day `days` from now, for a `@db.Date` column. */
export function dayOffset(days: number): Date {
  const at = new Date(Date.now() + days * DAY_MS);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function insertCustomer(tx: DbClient, name: string | null) {
  return tx.customer.create({ data: { origin: "crm", status: "active", name }, select: { id: true } });
}

function insertVehicle(tx: DbClient, customerId: string, plate: string, model: string) {
  return tx.vehicle.create({ data: { customerId, origin: "crm", plate, model }, select: { id: true } });
}

/** One text message on a conversation. */
export function insertFollowUpMessage(
  tx: DbClient,
  input: {
    conversationId: string;
    direction: "inbound" | "outbound";
    at: Date;
    shouldReply?: boolean | null;
    textBody?: string;
  },
) {
  return tx.message.create({
    data: {
      conversationId: input.conversationId,
      externalMessageId: randomUUID(),
      direction: input.direction,
      messageType: "text",
      textBody: input.textBody ?? null,
      providerTimestamp: input.at,
      shouldReply: input.shouldReply ?? null,
    },
    select: { id: true },
  });
}

/** A conversation on `connectionId`, linked to a fresh customer named `label`. */
export async function insertFollowUpThread(tx: DbClient, connectionId: string, label: string | null) {
  const customer = await insertCustomer(tx, label);
  const conversation = await seedConversation(tx, { connectionId });
  await tx.conversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  return { conversationId: conversation.id, customerId: customer.id };
}

function insertQuote(
  tx: DbClient,
  input: { customerId: string; vehicleId: string; conversationId: string; createdAt: Date; userId: string },
) {
  return tx.oilQuote.create({
    data: {
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      conversationId: input.conversationId,
      generatedMessageText: `Orçamento ${randomUUID().slice(0, 8)}`,
      createdByUserId: input.userId,
      createdAt: input.createdAt,
    },
    select: { id: true },
  });
}

/**
 * An OPEN return for a fresh customer and vehicle in `unitId`, with one
 * reminder carrying `reminderMoments` SCHEDULED send moments.
 */
async function insertReturn(
  tx: DbClient,
  input: { unitId: string; customerName: string; dayOffsetDays: number; reminderMoments: Date[]; userId: string },
) {
  const customer = await insertCustomer(tx, input.customerName);
  const vehicle = await insertVehicle(tx, customer.id, `AAA-${randomUUID().slice(0, 4)}`, "Corolla");
  const service = await tx.service.create({
    data: { customerId: customer.id, vehicleId: vehicle.id, unitId: input.unitId, origin: "crm" },
    select: { id: true },
  });
  const vehicleReturn = await tx.vehicleReturn.create({
    data: { vehicleId: vehicle.id, sourceServiceId: service.id, returnDate: dayOffset(input.dayOffsetDays), status: "OPEN" },
    select: { id: true },
  });
  if (input.reminderMoments.length > 0) {
    const reminder = await tx.returnReminderMessage.create({
      data: { vehicleReturnId: vehicleReturn.id, bodyTemplate: "Seu retorno está próximo", createdByUserId: input.userId },
      select: { id: true },
    });
    for (const moment of input.reminderMoments) {
      await tx.scheduledMessage.create({
        data: {
          returnReminderMessageId: reminder.id,
          customerId: customer.id,
          frozenText: "Seu retorno está próximo",
          scheduledAt: moment,
          status: "SCHEDULED",
          idempotencyKey: randomUUID(),
          createdByUserId: input.userId,
        },
      });
    }
  }
  return { returnId: vehicleReturn.id, customerId: customer.id, vehicleId: vehicle.id };
}

/**
 * The whole Follow-up scenario: one loja with a quote pair, an answered quote,
 * an aguardando thread, a cleared one, an unlabeled one, a vencido return
 * carrying two future reminders and an aproximando return with none — plus a
 * second loja, which the user does NOT belong to, whose quote must never be
 * listed.
 *
 * @param tx - The test transaction.
 * @param userId - The member user to create; generated when omitted.
 */
export async function seedFollowUpScenario(tx: DbClient, userId?: string) {
  const now = Date.now();
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const user = await seedUser(tx, { units: [unit.id], ...(userId ? { id: userId } : {}) });

  // Another loja the caller does NOT belong to, with a full row chain of its own.
  const otherUnit = await seedUnit(tx);
  const otherConnection = await seedConnection(tx, { unitId: otherUnit.id });
  const otherThread = await insertFollowUpThread(tx, otherConnection.id, "Outra loja");
  const otherVehicle = await insertVehicle(tx, otherThread.customerId, "ZZZ-0Z00", "Gol");
  await insertQuote(tx, {
    customerId: otherThread.customerId,
    vehicleId: otherVehicle.id,
    conversationId: otherThread.conversationId,
    createdAt: new Date(now - 10 * DAY_MS),
    userId: user.id,
  });

  // Two unanswered quotes in one thread: they collapse to the newer.
  const quotes = await insertFollowUpThread(tx, connection.id, "Roberto");
  const quotesVehicle = await insertVehicle(tx, quotes.customerId, "ABC-1D23", "Corolla");
  const quoteIn = (createdAt: Date) =>
    insertQuote(tx, {
      customerId: quotes.customerId,
      vehicleId: quotesVehicle.id,
      conversationId: quotes.conversationId,
      createdAt,
      userId: user.id,
    });
  const older = await quoteIn(new Date(now - 9 * DAY_MS));
  const newer = await quoteIn(new Date(now - 4 * DAY_MS));

  // A quote with a later inbound: answered, so it leaves the section.
  const answered = await insertFollowUpThread(tx, connection.id, "Answered");
  const answeredVehicle = await insertVehicle(tx, answered.customerId, "DEF-4G56", "Civic");
  const answeredQuote = await insertQuote(tx, {
    customerId: answered.customerId,
    vehicleId: answeredVehicle.id,
    conversationId: answered.conversationId,
    createdAt: new Date(now - 9 * DAY_MS),
    userId: user.id,
  });
  await insertFollowUpMessage(tx, {
    conversationId: answered.conversationId,
    direction: "inbound",
    at: new Date(now - 8 * DAY_MS),
  });

  // shouldReply pending, nothing outbound after it: aguardando.
  const waiting = await insertFollowUpThread(tx, connection.id, "Juliana");
  await insertFollowUpMessage(tx, {
    conversationId: waiting.conversationId,
    direction: "inbound",
    at: new Date(now - 3 * DAY_MS),
    shouldReply: true,
  });

  // Same, but answered by a later outbound: cleared.
  const cleared = await insertFollowUpThread(tx, connection.id, "Cleared");
  await insertFollowUpMessage(tx, {
    conversationId: cleared.conversationId,
    direction: "inbound",
    at: new Date(now - 3 * DAY_MS),
    shouldReply: true,
  });
  await insertFollowUpMessage(tx, {
    conversationId: cleared.conversationId,
    direction: "outbound",
    at: new Date(now - 2 * DAY_MS),
  });

  // An inbound nobody labelled: not aguardando.
  const unlabeled = await insertFollowUpThread(tx, connection.id, "Unlabeled");
  await insertFollowUpMessage(tx, {
    conversationId: unlabeled.conversationId,
    direction: "inbound",
    at: new Date(now - 3 * DAY_MS),
  });

  // Reminder moments must be in the FUTURE to be counted as planned, and are
  // inserted out of order so the "next" assertion tests the sort.
  const firstMoment = new Date(now + 2 * DAY_MS);
  const secondMoment = new Date(now + 5 * DAY_MS);
  const overdue = await insertReturn(tx, {
    unitId: unit.id,
    customerName: "Overdue",
    dayOffsetDays: -10,
    reminderMoments: [secondMoment, firstMoment],
    userId: user.id,
  });
  const upcoming = await insertReturn(tx, {
    unitId: unit.id,
    customerName: "Soon",
    dayOffsetDays: 7,
    reminderMoments: [],
    userId: user.id,
  });

  return {
    unitId: unit.id,
    userId: user.id,
    otherUnitId: otherUnit.id,
    quotesConversationId: quotes.conversationId,
    answeredConversationId: answered.conversationId,
    otherConversationId: otherThread.conversationId,
    olderQuoteId: older.id,
    newerQuoteId: newer.id,
    answeredQuoteId: answeredQuote.id,
    waitingConversationId: waiting.conversationId,
    clearedConversationId: cleared.conversationId,
    unlabeledConversationId: unlabeled.conversationId,
    overdueCustomerId: overdue.customerId,
    overdueReturnId: overdue.returnId,
    upcomingCustomerId: upcoming.customerId,
    overdueReturnDate: dayOffset(-10).toISOString().slice(0, 10),
    upcomingReturnDate: dayOffset(7).toISOString().slice(0, 10),
    firstMomentIso: firstMoment.toISOString(),
  };
}

/**
 * One loja, one thread that is in BOTH message-pendency sections at once: an
 * unanswered quote and a pending shouldReply. The inbound is seeded BEFORE the
 * quote: a later inbound would answer the quote, so the entry would never be in
 * that section (F5 in the original file).
 *
 * @param tx - The test transaction.
 * @param userId - The member user to create; generated when omitted.
 */
export async function seedClosableFollowUp(tx: DbClient, userId?: string) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const user = await seedUser(tx, { units: [unit.id], ...(userId ? { id: userId } : {}) });
  const thread = await insertFollowUpThread(tx, connection.id, "Roberto");
  const vehicle = await insertVehicle(tx, thread.customerId, "ABC-1D23", "Corolla");
  // Pending because nothing outbound follows it, and harmless to the quote
  // because it precedes it.
  await insertFollowUpMessage(tx, {
    conversationId: thread.conversationId,
    direction: "inbound",
    at: new Date(Date.now() - 9 * DAY_MS),
    shouldReply: true,
  });
  const quote = await insertQuote(tx, {
    customerId: thread.customerId,
    vehicleId: vehicle.id,
    conversationId: thread.conversationId,
    createdAt: new Date(Date.now() - 3 * DAY_MS),
    userId: user.id,
  });
  return { unitId: unit.id, userId: user.id, conversationId: thread.conversationId, quoteId: quote.id };
}
