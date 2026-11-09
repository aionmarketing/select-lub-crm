/**
 * Delete live ingest and keep seeded history plus conversations.
 *
 * Does not check DATABASE_URL — the CLI does that via
 * {@link resolveScrubLivePermission} so this function can be sampled in tests
 * without going through process.exit.
 */
import type { PrismaClient } from "@prisma/client";
import { MESSAGE_ORIGIN_SEED } from "../../shared/message-origin.js";

/** Counts of rows the scrub removed. A second run on a clean database is zeros. */
export type ScrubLiveResult = {
  readonly deletedMessages: number;
  readonly deletedOutbox: number;
  readonly deletedWebhookEvents: number;
};

/**
 * Removes `LIVE` (and any non-`SEED`) messages, outbox on those conversations,
 * and webhook events for the live Evolution instance.
 *
 * Conversations, phones, and `SEED` messages stay. Cadastro is untouched.
 *
 * @param prisma - Shared Prisma client.
 * @param input.liveInstanceName - `EVOLUTION_INSTANCE_NAME`; events on that connection go.
 */
export async function scrubLiveDataset(
  prisma: PrismaClient,
  input: { liveInstanceName: string },
): Promise<ScrubLiveResult> {
  const liveRows = await prisma.message.findMany({
    where: { origin: { not: MESSAGE_ORIGIN_SEED } },
    select: { conversationId: true },
  });
  const conversationIds = [...new Set(liveRows.map((row) => row.conversationId))];

  const deletedMessages = await prisma.message.deleteMany({
    where: { origin: { not: MESSAGE_ORIGIN_SEED } },
  });

  const deletedOutbox =
    conversationIds.length === 0
      ? { count: 0 }
      : await prisma.outboxMessage.deleteMany({
          where: { conversationId: { in: conversationIds } },
        });

  const liveConnection = await prisma.whatsAppConnection.findUnique({
    where: { instanceName: input.liveInstanceName },
    select: { id: true },
  });
  const deletedWebhookEvents = liveConnection
    ? await prisma.webhookEvent.deleteMany({
        where: { whatsappConnectionId: liveConnection.id },
      })
    : { count: 0 };

  return {
    deletedMessages: deletedMessages.count,
    deletedOutbox: deletedOutbox.count,
    deletedWebhookEvents: deletedWebhookEvents.count,
  };
}
