/**
 * Shared setup for drain-prefill's two case files — the drain's own cases
 * (`drain-prefill.integration.test.ts`) and the extraction's
 * (`drain-prefill.extract.integration.test.ts`). Split out of the one file the
 * cases were moved into, which was over the 300-line limit; nothing changed.
 */
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { runInTransactionOnTx, seedConnection, seedConversation, seedUnit } from "@select-lub/core/testing";
import { PREFILL_WINDOW_MS, type PrefillCadastroSnapshot } from "../index.js";

export const PHONE = "5511988887777";
export const windowStart = new Date("2026-08-31T12:00:00.000Z");
export const closedNow = new Date(windowStart.getTime() + PREFILL_WINDOW_MS);

/** A cadastro snapshot for the pure projection logic; a value, as before. */
export function snapshot(partial: Partial<PrefillCadastroSnapshot> = {}): PrefillCadastroSnapshot {
  return {
    customerId: "cus-e",
    phoneNormalized: PHONE,
    name: PHONE,
    taxId: null,
    plate: null,
    make: null,
    model: null,
    version: null,
    year: null,
    odometerKm: null,
    plateSourcedKeys: [],
    ...partial,
  };
}

/** One thread message to insert. */
export type SeedMessage = {
  externalMessageId: string;
  direction: "inbound" | "outbound";
  providerTimestamp: Date;
  textBody?: string | null;
  messageType?: string;
};

/** The nth alternating text message, at a fixed second; even is inbound. */
export function line(n: number, at: string): SeedMessage {
  return {
    externalMessageId: `msg-${n}`,
    direction: n % 2 === 0 ? "inbound" : "outbound",
    textBody: `msg-${n}`,
    providerTimestamp: new Date(at),
  };
}

/** An inbound text at the window start. */
export function closedInbound(externalMessageId = "in-1", textBody = "preciso de um orçamento"): SeedMessage {
  return { externalMessageId, direction: "inbound", textBody, providerTimestamp: windowStart };
}

/** A unit, connection, conversation (switch on) and its thread, and a handle over the transaction. */
export async function setup(tx: DbClient, messages: readonly SeedMessage[] = []) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  await tx.conversation.update({ where: { id: conversation.id }, data: { prefillExtractEnabled: true } });
  for (const message of messages) {
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        messageType: message.messageType ?? "text",
        textBody: message.textBody ?? null,
        providerTimestamp: message.providerTimestamp,
      },
    });
  }
  return { conversation, handle: createDb(tx, runInTransactionOnTx(tx)) };
}

/** A queued job, as the scan inserts it. */
export function insertQueuedJob(tx: DbClient, conversationId: string) {
  return tx.cadastroPrefillJob.create({ data: { conversationId, status: "queued" } });
}

/** This conversation's prefill jobs, oldest first. */
export function jobsOf(tx: DbClient, conversationId: string) {
  return tx.cadastroPrefillJob.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
}

export async function suggestionOf(tx: DbClient, conversationId: string) {
  const row = await tx.cadastroPrefillSuggestion.findUnique({ where: { conversationId } });
  return row?.fields;
}

export async function watermarkOf(tx: DbClient, conversationId: string) {
  const row = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
  return row.lastPrefillWindowClosedAt;
}

export async function labelOf(tx: DbClient, conversationId: string, externalMessageId: string) {
  const row = await tx.message.findFirstOrThrow({
    where: { conversationId, externalMessageId },
    select: { shouldReply: true },
  });
  return row.shouldReply;
}
