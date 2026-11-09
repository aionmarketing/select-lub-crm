/**
 * Everything `GET /reports/conversations` reads, in one round of queries, mapped
 * to the shapes the report aggregation takes.
 *
 * Reads span five modules — conversations, scheduling, services, quotes and
 * this one — which `ownership.json` allows as `readableBy: "*"`. The only
 * writes the slice makes are the attribution rows, and those are
 * `internal/recompute-attribution.ts`'s, not this file's.
 *
 * Each read runs in its own `db.tx("reports", …)`, and the ten run together in
 * one `Promise.all`. That mirrors the old adapter, which ran every read in
 * autocommit on the pool: there was never cross-read consistency to preserve,
 * so there is no reason to share a transaction. Sharing one would put all ten
 * on a single connection — one after another instead of in parallel — under a
 * single 5 s interactive-transaction budget; one each gives every statement its
 * own budget and keeps them concurrent in production.
 *
 * Moved from `createPrismaReportsStore().summary` in
 * `apps/api/src/reports/prisma.ts`, with the queries and the mapping unchanged.
 */
import type { Db } from "../../../kernel/db.js";
import type { ConversationSourceType, ReportQuery } from "../contracts/http.js";
import type { IntervalRuleInput } from "../../services/contracts/http.js";
import type { ReportConversationRow, ReportScheduledRow } from "../internal/aggregate.js";
import type {
  AttributionQuoteRow,
  AttributionScheduledAnchor,
  AttributionServiceRow,
} from "../internal/attribution.js";
import type { StoredAttributions } from "../internal/recompute-attribution.js";

/** What the report is built from, for one unit and one cut. */
export type ReportFacts = {
  rows: ReportConversationRow[];
  scheduled: ReportScheduledRow[];
  /** The newest stored attribution rule, or null when none is stored. */
  ruleRow: { version: number; windowDays: number } | null;
  services: AttributionServiceRow[];
  anchors: AttributionScheduledAnchor[];
  stored: StoredAttributions;
  quotes: AttributionQuoteRow[];
  intervalRules: IntervalRuleInput[];
};

function asSourceType(value: string): ConversationSourceType {
  if (value === "AD" || value === "ORGANIC" || value === "UNKNOWN") {
    return value;
  }
  return "UNKNOWN";
}

function asDirection(value: string): "inbound" | "outbound" | null {
  if (value === "inbound" || value === "outbound") {
    return value;
  }
  return null;
}

function conversationWhere(unitId: string, query: ReportQuery) {
  return {
    whatsappConnection: { unitId },
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    ...(query.tagId
      ? {
          conversationTags: {
            some: { tagId: query.tagId, removedAt: null, tag: { active: true } },
          },
        }
      : {}),
  };
}

/**
 * Loads the report's facts.
 *
 * @param db - The database handle; each read gets its own `db.tx("reports", …)`.
 * @param unitId - The unit the report is scoped to.
 * @param query - Period, granularity and the optional origin, tag and campaign filters.
 * @returns The mapped facts. Conversation filters narrow the conversations and
 *   the scheduled rows reached through them; with any filter on, scheduled rows
 *   reached only through a service are left out, since they have no
 *   conversation to match the filter against.
 */
export async function loadReportFacts(
  db: Db,
  unitId: string,
  query: ReportQuery,
): Promise<ReportFacts> {
  const where = conversationWhere(unitId, query);
  const conversationFiltersOn =
    Boolean(query.tagId) || Boolean(query.campaignId) || Boolean(query.sourceType);

  const [conversations, scheduled, ruleRow, services, sentAnchors, existingScheduled, existingConversations, existingQuotes, oilQuotes, intervalRules] =
    await Promise.all([
      db.tx("reports", (tx) =>
        tx.conversation.findMany({
          where,
          select: {
            id: true,
            customerId: true,
            sourceType: true,
            firstInboundAt: true,
            firstOutboundAt: true,
            campaignId: true,
            adSetId: true,
            adId: true,
            whatsappConnection: { select: { unitId: true } },
            messages: { select: { direction: true, providerTimestamp: true, shouldReply: true } },
            conversationTags: {
              where: { removedAt: null, tag: { active: true } },
              select: { tag: { select: { id: true, name: true, active: true } } },
            },
          },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.scheduledMessage.findMany({
          where: {
            OR: [
              { conversation: where },
              ...(conversationFiltersOn ? [] : [{ service: { unitId } }]),
            ],
          },
          select: { status: true, scheduledAt: true, sentAt: true },
        }),
      ),
      db.tx("reports", (tx) => tx.attributionRule.findFirst({ orderBy: { version: "desc" } })),
      db.tx("reports", (tx) =>
        tx.service.findMany({
          where: { unitId },
          select: {
            id: true,
            unitId: true,
            customerId: true,
            vehicleId: true,
            omieId: true,
            origin: true,
            performedAt: true,
            amount: true,
          },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.scheduledMessage.findMany({
          where: {
            status: "SENT",
            sentAt: { not: null },
            OR: [
              { conversation: { whatsappConnection: { unitId } } },
              { service: { unitId } },
            ],
          },
          select: {
            id: true,
            status: true,
            customerId: true,
            sentAt: true,
            service: { select: { vehicleId: true, unitId: true } },
            conversation: { select: { whatsappConnection: { select: { unitId: true } } } },
          },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.serviceScheduledAttribution.findMany({
          where: { service: { unitId } },
          select: { serviceId: true, scheduledMessageId: true, ruleVersion: true },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.serviceConversationAttribution.findMany({
          where: { service: { unitId } },
          select: { serviceId: true, conversationId: true, ruleVersion: true },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.serviceQuoteAttribution.findMany({
          where: { service: { unitId } },
          select: { serviceId: true, quoteId: true, ruleVersion: true },
        }),
      ),
      db.tx("reports", (tx) =>
        tx.oilQuote.findMany({
          where: { conversation: { whatsappConnection: { unitId } } },
          select: {
            id: true,
            conversationId: true,
            customerId: true,
            createdAt: true,
          },
        }),
      ),
      db.tx("reports", (tx) => tx.intervalRule.findMany()),
    ]);

  const rows: ReportConversationRow[] = conversations.map((row) => ({
    conversationId: row.id,
    unitId: row.whatsappConnection.unitId,
    sourceType: asSourceType(row.sourceType),
    firstInboundAt: row.firstInboundAt,
    firstOutboundAt: row.firstOutboundAt,
    campaignId: row.campaignId,
    adSetId: row.adSetId,
    adId: row.adId,
    customerId: row.customerId,
    tags: row.conversationTags.map((apply) => ({
      tagId: apply.tag.id,
      name: apply.tag.name,
      active: apply.tag.active,
    })),
    messages: row.messages.flatMap((message) => {
      const direction = asDirection(message.direction);
      if (!direction) {
        return [];
      }
      return [{ direction, providerTimestamp: message.providerTimestamp, shouldReply: message.shouldReply }];
    }),
  }));

  return {
    rows,
    scheduled,
    ruleRow: ruleRow ? { version: ruleRow.version, windowDays: ruleRow.windowDays } : null,
    services: services.map((row) => ({
      id: row.id,
      unitId: row.unitId,
      customerId: row.customerId,
      vehicleId: row.vehicleId,
      omieId: row.omieId,
      origin: row.origin,
      performedAt: row.performedAt,
      amount: row.amount == null ? null : Number(row.amount),
    })),
    anchors: sentAnchors.map((row) => ({
      id: row.id,
      status: row.status,
      sentAt: row.sentAt,
      customerId: row.customerId,
      referenceVehicleId: row.service?.vehicleId ?? null,
      unitId: row.conversation?.whatsappConnection.unitId ?? row.service?.unitId ?? unitId,
    })),
    stored: {
      scheduled: existingScheduled,
      conversation: existingConversations,
      quote: existingQuotes.map((row) => ({
        serviceId: row.serviceId,
        quoteId: row.quoteId,
        ruleVersion: row.ruleVersion,
      })),
    },
    quotes: oilQuotes.map((row) => ({
      quoteId: row.id,
      conversationId: row.conversationId,
      customerId: row.customerId,
      unitId,
      createdAt: row.createdAt,
    })),
    intervalRules: intervalRules.map((rule) => ({
      id: rule.id,
      version: rule.version,
      criterion: rule.criterion,
      criterionId: rule.criterionId,
      intervalAmount: rule.intervalAmount,
      intervalUnit: rule.intervalUnit === "days" ? "days" : "months",
      priority: rule.priority,
      active: rule.active,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
    })),
  };
}
