/**
 * Recomputes the attribution association rows for one unit and one report cut,
 * writes the new ones, and returns every pair the counts should see.
 *
 * Triggered inline by the report read, exactly as before the reports module
 * existed: `GET /reports/conversations` computes the REP-11 (scheduled return),
 * REP-12 (conversion) and quote-approval candidates for the cut and inserts any
 * that are missing, so the counts it returns include them. There is no job and
 * no separate route, which is why this is internal logic rather than a slice of
 * its own (adopt-modular-vertical-slices W2-C4).
 *
 * The three tables written here — `service_scheduled_attribution`,
 * `service_conversation_attribution`, `service_quote_attribution` — are owned by
 * `reports`. Each insert runs in its own `db.tx("reports", …)`, one after the
 * other: the three were never atomic together (the old adapter ran them as three
 * autocommit statements), and each is idempotent on its own — `skipDuplicates`
 * over the table's unique key — so a repeat read, or two concurrent ones, adds
 * no row twice. Grouping them would only lengthen one transaction under Prisma's
 * 5 s interactive-transaction limit for nothing.
 *
 * Moved from `createPrismaReportsStore().summary` in
 * `apps/api/src/reports/prisma.ts`, with its logic unchanged.
 */
import type { Db } from "../../../kernel/db.js";
import type { ReportQuery } from "../contracts/http.js";
import type { ReportConversationRow } from "./aggregate.js";
import {
  conversionInserts,
  quoteApprovalInserts,
  scheduledReturnInserts,
  type AttributionQuoteRow,
  type AttributionScheduledAnchor,
  type AttributionServiceRow,
  type ConversationAttributionRow,
  type QuoteAttributionRow,
  type ScheduledAttributionRow,
} from "./attribution.js";

/** The association rows already stored for the unit, one list per table. */
export type StoredAttributions = {
  scheduled: ScheduledAttributionRow[];
  conversation: ConversationAttributionRow[];
  quote: QuoteAttributionRow[];
};

/**
 * Inserts the attribution rows the cut is missing.
 *
 * @param db - The database handle; each insert gets its own `db.tx("reports", …)`.
 * @param input.unitId - The unit the report is scoped to.
 * @param input.query - The report cut; REP-11 candidates are the period's services.
 * @param input.rule - The current attribution rule (window and version).
 * @param input.services - The unit's services.
 * @param input.anchors - SENT scheduled messages already resolved to the unit.
 * @param input.novas - The cut's linked novas, from `linkedNovas`.
 * @param input.quotes - The unit's sent oil quotes.
 * @param input.stored - What is already stored, so no pair is inserted twice.
 * @returns Stored plus newly inserted pairs, per table — what the counts read.
 */
export async function recomputeAttribution(
  db: Db,
  input: {
    unitId: string;
    query: ReportQuery;
    rule: { version: number; windowDays: number };
    services: AttributionServiceRow[];
    anchors: AttributionScheduledAnchor[];
    novas: ReportConversationRow[];
    quotes: AttributionQuoteRow[];
    stored: StoredAttributions;
  },
): Promise<StoredAttributions> {
  const { unitId, query, rule, services, stored } = input;
  const scheduledInserts = scheduledReturnInserts(
    services,
    input.anchors,
    stored.scheduled,
    rule,
    unitId,
    query,
  );
  const conversationInserts = conversionInserts(input.novas, services, stored.conversation, rule, unitId);
  const quoteInserts = quoteApprovalInserts(input.quotes, services, stored.quote, rule, unitId);

  // One db.tx per insert, awaited in turn — never concurrently, so the rollback
  // harness, which runs every db.tx on one test transaction, sees them nest
  // cleanly rather than interleave.
  if (scheduledInserts.length > 0) {
    await db.tx("reports", (tx) =>
      tx.serviceScheduledAttribution.createMany({ data: scheduledInserts, skipDuplicates: true }),
    );
  }
  if (conversationInserts.length > 0) {
    await db.tx("reports", (tx) =>
      tx.serviceConversationAttribution.createMany({
        data: conversationInserts,
        skipDuplicates: true,
      }),
    );
  }
  if (quoteInserts.length > 0) {
    await db.tx("reports", (tx) =>
      tx.serviceQuoteAttribution.createMany({
        data: quoteInserts,
        skipDuplicates: true,
      }),
    );
  }

  return {
    scheduled: [...stored.scheduled, ...scheduledInserts],
    conversation: [...stored.conversation, ...conversationInserts],
    quote: [...stored.quote, ...quoteInserts],
  };
}
