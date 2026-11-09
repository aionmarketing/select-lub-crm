/**
 * Where the fixture seed places each seeded conversation's first inbound.
 *
 * WHY NOT ALL AT `now`. The seed used to stamp every conversation's
 * `firstInboundAt` with the instant it first ran, and only on CREATE. That left
 * two failures that look like one:
 *
 * - On a fresh database every nova fell on a single São Paulo day, so the
 *   screen's default period drew ONE daily bucket and ONE monthly bucket. The
 *   Relatórios Colecionador tour walks "Granularity day week month without
 *   double-count", which is only observable when day buckets outnumber month
 *   buckets while the total stays put; with one bucket each it failed on
 *   `expect(dailyRows).toBeGreaterThan(1)` every run.
 * - On a database seeded days ago the timestamps never moved, so once they were
 *   more than seven days old the default period was an empty cut.
 *
 * So the seed derives the instant from the run's `now` and writes it on UPDATE
 * as well, the way it already pins `sourceType`. The spread is two days back,
 * three São Paulo days in all: three is the least that makes a month grouping
 * strictly smaller than a day grouping on a month boundary (a window that
 * straddles one has two month buckets), and it stays inside the seven-day
 * default period on every day of the year.
 *
 * Only the conversations named here move. The rest stay at `now`, which keeps
 * the inbox, the Follow-up queues and the oil-quote fixtures reading the same
 * instant they always did; `lastMessageAt` and the messages are never touched
 * here for the same reason.
 */
import { E2E } from "./ids.js";

/** Whole days before `now` that a conversation's first inbound is placed; absent means `now`. */
export const NOVA_DAYS_AGO: Readonly<Record<string, number>> = {
  [E2E.prefillAcceptConversationId]: 1,
  [E2E.prefillDismissConversationId]: 2,
};

/**
 * The instant a seeded conversation's first inbound is placed at.
 *
 * Whole multiples of 24 hours, never calendar arithmetic: America/Sao_Paulo has
 * no daylight saving now, and two instants 24 hours apart are always on
 * different São Paulo days.
 *
 * @param now - The seed run's reference instant.
 * @param conversationId - The seeded conversation.
 * @returns `now`, or `now` minus the conversation's spread.
 */
export function novaFirstInboundAt(now: Date, conversationId: string): Date {
  return new Date(now.getTime() - (NOVA_DAYS_AGO[conversationId] ?? 0) * 86_400_000);
}
