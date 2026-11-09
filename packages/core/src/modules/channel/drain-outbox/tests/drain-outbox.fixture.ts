/**
 * Shared setup for the drain-outbox suites: seeds a thread, queues real
 * `outbox_message` rows, stubs Evolution, and records what the drain published.
 *
 * Moved from the helpers at the top of `apps/worker/src/outbox/drain.test.ts`.
 * Two changed. `setup` now returns a `Db` over the test transaction instead of
 * the two worker stores, because the drain writes through `db.tx("channel")`.
 * And the old `outboundOf` — which read the `message` rows the drain used to
 * insert — is replaced by {@link drainCapturing}: the drain no longer writes
 * `message` (exception W3-C4), it publishes `channel/outbound-sent`, so an
 * assertion that a canonical message was inserted becomes an assertion that one
 * outbound-sent event was published with the same fields.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { createDb, type Db, type DbClient } from "../../../../kernel/db.js";
import { capture } from "../../../../kernel/events.js";
import { outboundSent, type OutboundSent } from "../../contracts/outbound-sent.js";
import {
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
} from "../../../../testing/index.js";
import type { EvolutionSend } from "../index.js";

export const CHAT_KEY = "5511999999999";

export const db = () => prisma as PrismaClient;

/**
 * An `EvolutionSend` whose unspecified methods refuse.
 *
 * @param partial - The methods this test cares about.
 * @returns The stub.
 */
export function stubEvolution(
  partial: Pick<EvolutionSend, "sendText"> & Partial<EvolutionSend>,
): EvolutionSend {
  const unusedSend = async () => ({ ok: false as const, kind: "refused" as const, error: "unused" });
  return {
    sendWhatsAppAudio: unusedSend,
    sendMedia: unusedSend,
    async getBase64FromMediaMessage() {
      return { ok: false, disconnected: false, error: "unused" };
    },
    ...partial,
  };
}

/**
 * An `EvolutionSend` whose `sendText` always returns the same result.
 *
 * @param result - The result to return.
 * @returns The stub.
 */
export function mockEvolution(result: Awaited<ReturnType<EvolutionSend["sendText"]>>): EvolutionSend {
  return stubEvolution({
    async sendText() {
      return result;
    },
  });
}

/** A `sendText` stub that confirms every send with a distinct provider id. */
export function countingEvolution(prefix = "out"): { evolution: EvolutionSend; sent: () => number } {
  let sent = 0;
  return {
    evolution: stubEvolution({
      async sendText() {
        sent += 1;
        return {
          ok: true,
          externalMessageId: `${prefix}-${sent}`,
          providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
        };
      },
    }),
    sent: () => sent,
  };
}

/** Media columns for a queued outbox row. */
export type SeedMedia = {
  messageType: string;
  mediaBytes?: Uint8Array | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
};

/**
 * Seeds a unit, connection and conversation, and a `Db` over the transaction.
 *
 * @param tx - The test transaction.
 * @param chatKey - Thread chat key.
 * @returns The connection, the conversation id and the handle.
 */
export async function setup(tx: DbClient, chatKey = CHAT_KEY) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, {
    connectionId: connection.id,
    chatKey,
    remoteJid: `${chatKey}@s.whatsapp.net`,
  });
  const handle: Db = createDb(tx, runInTransactionOnTx(tx));
  return { connection, conversationId: conversation.id, db: handle };
}

/**
 * Inserts one queued outbox row.
 *
 * @param tx - The test transaction.
 * @param conversationId - Conversation the row belongs to.
 * @param textBody - Body or caption; null for a bodyless row.
 * @param media - Optional media columns; defaults to a text row.
 * @returns The new row's id.
 */
export async function enqueue(
  tx: DbClient,
  conversationId: string,
  textBody: string | null,
  media?: SeedMedia,
): Promise<string> {
  const row = await tx.outboxMessage.create({
    data: {
      conversationId,
      messageType: media?.messageType ?? "text",
      textBody,
      status: "queued",
      ...(media?.mediaBytes ? { mediaBytes: Buffer.from(media.mediaBytes) } : {}),
      ...(media?.mediaMimeType === undefined ? {} : { mediaMimeType: media.mediaMimeType }),
      ...(media?.mediaFileName === undefined ? {} : { mediaFileName: media.mediaFileName }),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Seeds a thread with `count` queued text rows.
 *
 * @param tx - The test transaction.
 * @param count - How many rows to queue.
 * @returns The handle, the conversation id and the queued row ids.
 */
export async function seedQueuedItems(tx: DbClient, count: number) {
  const base = await setup(tx);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await enqueue(tx, base.conversationId, `reply-${i}`));
  }
  return { ...base, ids };
}

/** Reads one outbox row back by its id. */
export function rowOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({ where: { id } });
}

/** This conversation's outbox rows. */
export function rowsOf(tx: DbClient, conversationId: string) {
  return tx.outboxMessage.findMany({ where: { conversationId } });
}

/**
 * Ages a row past the retry backoff, in SQL.
 *
 * `updated_at` is `@updatedAt`, so a Prisma update would overwrite it with the
 * client clock, and the claim's predicate reads the database clock.
 *
 * @param tx - The test transaction.
 * @param id - The row to age.
 */
export async function ageBeyondBackoff(tx: DbClient, id: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE outbox_message SET updated_at = NOW() - INTERVAL '31 seconds' WHERE id = ${id}
  `;
}

/**
 * Runs `fn` and returns the outbound-sent events published for `connectionId`
 * while it ran — the stand-in for the old `outboundOf` read of `message`.
 *
 * Filtered by connection because subscribers are process-global and another
 * file in the same worker may be draining at the same moment.
 *
 * @param connectionId - The test's own connection.
 * @param fn - The drain call(s).
 * @returns The payloads, in publish order.
 */
export async function drainCapturing(
  connectionId: string,
  fn: () => Promise<unknown>,
): Promise<OutboundSent[]> {
  const seen = await capture(outboundSent, async () => {
    await fn();
  });
  return seen.filter((event) => event.whatsappConnectionId === connectionId);
}
