/**
 * Reads outbox rows for the live suite straight from Postgres.
 *
 * `GET /conversations/:id/messages` attaches `outboxStatus` only to rows that are
 * NOT yet `confirmed` — a confirmed send is represented by its canonical message
 * instead. So `outboxStatus === "confirmed"` is unreachable over HTTP, and a
 * negative written against that field passes vacuously. Assert on the table.
 */
import { PrismaClient } from "@select-lub/core/db";

/** One outbox row, narrowed to what the live oracles check. */
export type LiveOutboxRow = {
  status: string;
  externalMessageId: string | null;
  attemptCount: number;
  lastError: string | null;
};

/**
 * Returns every outbox row on `conversationId` whose body is exactly `textBody`.
 *
 * @param conversationId - Live conversation under test
 * @param textBody - Unique run-branded body
 * @returns Matching rows, oldest first; empty when nothing was ever enqueued
 */
export async function outboxRowsFor(
  conversationId: string,
  textBody: string,
): Promise<LiveOutboxRow[]> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.outboxMessage.findMany({
      where: { conversationId, textBody },
      orderBy: { createdAt: "asc" },
      select: { status: true, externalMessageId: true, attemptCount: true, lastError: true },
    });
    return rows;
  } finally {
    await prisma.$disconnect();
  }
}
