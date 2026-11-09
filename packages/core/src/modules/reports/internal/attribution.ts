/**
 * REP-11 / REP-12 candidate evaluation and counts from association rows.
 * Stores persist the inserts; this module stays free of Prisma.
 */
import type { ConversationSourceType, ReportQuery, ReportResult } from "../contracts/http.js";
import { conversationInScope, type ReportConversationRow } from "./aggregate.js";
import { inHalfOpenPeriod } from "./calendar.js";

const MS_PER_DAY = 86_400_000;

/** Default rule inserted by the attribution migration (30-day version 1). */
export const DEFAULT_ATTRIBUTION_RULE = { version: 1, windowDays: 30 };

/** Empty attribution section used when no candidates match. */
export const EMPTY_ATTRIBUTION: ReportResult["attribution"] = {
  rule: DEFAULT_ATTRIBUTION_RULE,
  scheduledReturn: { count: 0 },
  conversion: { converted: 0, total: 0, bySource: [] },
};

/** Omie-origin service facts used as REP-11/REP-12 conclusion signals. */
export type AttributionServiceRow = {
  id: string;
  unitId: string;
  customerId: string;
  vehicleId: string | null;
  omieId: string | null;
  origin: string;
  performedAt: Date | null;
  amount: number | null;
};

/** SENT scheduled-message anchor for REP-11 (unit already resolved by the loader). */
export type AttributionScheduledAnchor = {
  id: string;
  unitId: string;
  status: string;
  sentAt: Date | null;
  customerId: string | null;
  referenceVehicleId: string | null;
};

/** Persisted REP-11 pair plus the rule version recorded at first insert. */
export type ScheduledAttributionRow = {
  serviceId: string;
  scheduledMessageId: string;
  ruleVersion: number;
};

/** Persisted REP-12 pair plus the rule version recorded at first insert. */
export type ConversationAttributionRow = {
  serviceId: string;
  conversationId: string;
  ruleVersion: number;
};

/** Quote-send anchor for Taxa de Aprovação; at most one quote per service. */
export type QuoteAttributionRow = {
  serviceId: string;
  quoteId: string;
  ruleVersion: number;
};

/** Oil-quote send used as the Taxa de Aprovação anchor. */
export type AttributionQuoteRow = {
  quoteId: string;
  conversationId: string | null;
  customerId: string;
  unitId: string;
  createdAt: Date;
};

/**
 * Picks the current global rule: highest version, or the migration default when none exist.
 *
 * @param rules - Stored rule versions; empty means nobody inserted beyond the default.
 * @returns The row with the greatest `version`, or `{ version: 1, windowDays: 30 }`.
 */
export function currentAttributionRule(rules: { version: number; windowDays: number }[]) {
  if (rules.length === 0) {
    return DEFAULT_ATTRIBUTION_RULE;
  }
  return rules.reduce((best, row) => (row.version > best.version ? row : best));
}

/**
 * True when `event` falls in `[anchor, anchor + windowDays]` on the elapsed clock.
 *
 * @param anchor - `sentAt` (REP-11) or `firstInboundAt` (REP-12).
 * @param event - Service `performedAt`.
 * @param windowDays - Whole days from the current (or recorded) rule.
 * @returns Whether the service date is inside the inclusive elapsed window.
 */
export function inAttributionWindow(anchor: Date, event: Date, windowDays: number) {
  const delta = event.getTime() - anchor.getTime();
  return delta >= 0 && delta <= windowDays * MS_PER_DAY;
}

function isOmieOrigin(service: AttributionServiceRow) {
  return service.omieId !== null && service.origin !== "crm";
}

function pairKey(left: string, right: string) {
  return `${left}\0${right}`;
}

/**
 * Novas in the report cut that have a linked customer (REP-12 denominator population).
 *
 * @param rows - Conversation facts already loaded for the unit.
 * @param unitId - Loja of the report request.
 * @param query - Period and origin/tag/campaign filters.
 * @returns Novas whose `customerId` is set.
 */
export function linkedNovas(
  rows: ReportConversationRow[],
  unitId: string,
  query: ReportQuery,
) {
  const periodStart = new Date(query.periodStart);
  const periodEnd = new Date(query.periodEnd);
  return rows.filter((row) => {
    if (!conversationInScope(row, unitId, query)) {
      return false;
    }
    if (!row.customerId || !row.firstInboundAt) {
      return false;
    }
    return inHalfOpenPeriod(row.firstInboundAt, periodStart, periodEnd);
  });
}

/**
 * REP-11 inserts under the current rule for Omie services in the period that match a SENT message.
 *
 * @param services - Unit services (caller may pass all units; this filters).
 * @param anchors - SENT scheduled messages already scoped to the unit.
 * @param existing - Association rows already stored (kept as-is, including older versions).
 * @param rule - Current global rule (window + version to record on new rows).
 * @param unitId - Loja of the report request.
 * @param query - Period used to select candidate services.
 * @returns New pairs only; existing keys are skipped (idempotent).
 */
export function scheduledReturnInserts(
  services: AttributionServiceRow[],
  anchors: AttributionScheduledAnchor[],
  existing: ScheduledAttributionRow[],
  rule: { version: number; windowDays: number },
  unitId: string,
  query: ReportQuery,
): ScheduledAttributionRow[] {
  const periodStart = new Date(query.periodStart);
  const periodEnd = new Date(query.periodEnd);
  const seen = new Set(existing.map((row) => pairKey(row.serviceId, row.scheduledMessageId)));
  const inserts: ScheduledAttributionRow[] = [];

  for (const service of services) {
    if (service.unitId !== unitId || !isOmieOrigin(service) || !service.performedAt) {
      continue;
    }
    if (!inHalfOpenPeriod(service.performedAt, periodStart, periodEnd)) {
      continue;
    }
    for (const anchor of anchors) {
      if (anchor.unitId !== unitId || anchor.status !== "SENT" || !anchor.sentAt) {
        continue;
      }
      const customerMatch = anchor.customerId !== null && anchor.customerId === service.customerId;
      const vehicleMatch =
        anchor.referenceVehicleId !== null &&
        service.vehicleId !== null &&
        anchor.referenceVehicleId === service.vehicleId;
      if (!customerMatch && !vehicleMatch) {
        continue;
      }
      if (!inAttributionWindow(anchor.sentAt, service.performedAt, rule.windowDays)) {
        continue;
      }
      const key = pairKey(service.id, anchor.id);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      inserts.push({
        serviceId: service.id,
        scheduledMessageId: anchor.id,
        ruleVersion: rule.version,
      });
    }
  }
  return inserts;
}

/**
 * REP-12 inserts under the current rule for linked novas whose customer has an Omie service in-window.
 *
 * @param novas - Linked novas from {@link linkedNovas}.
 * @param services - Services of any period; window is relative to `firstInboundAt`.
 * @param existing - Association rows already stored.
 * @param rule - Current global rule.
 * @param unitId - Loja of the report request.
 * @returns New pairs only.
 */
export function conversionInserts(
  novas: ReportConversationRow[],
  services: AttributionServiceRow[],
  existing: ConversationAttributionRow[],
  rule: { version: number; windowDays: number },
  unitId: string,
): ConversationAttributionRow[] {
  const seen = new Set(existing.map((row) => pairKey(row.serviceId, row.conversationId)));
  const inserts: ConversationAttributionRow[] = [];

  for (const nova of novas) {
    if (!nova.customerId || !nova.firstInboundAt) {
      continue;
    }
    for (const service of services) {
      if (service.unitId !== unitId || !isOmieOrigin(service) || !service.performedAt) {
        continue;
      }
      if (service.customerId !== nova.customerId) {
        continue;
      }
      if (!inAttributionWindow(nova.firstInboundAt, service.performedAt, rule.windowDays)) {
        continue;
      }
      const key = pairKey(service.id, nova.conversationId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      inserts.push({
        serviceId: service.id,
        conversationId: nova.conversationId,
        ruleVersion: rule.version,
      });
    }
  }
  return inserts;
}

/**
 * Quote-anchored inserts under the current rule: Omie service of the quote's customer in-window.
 * At most one quote is recorded per service (first matching quote wins).
 *
 * @param quotes - Quotes already scoped to the unit.
 * @param services - Services of any period; window is relative to `createdAt`.
 * @param existing - Association rows already stored.
 * @param rule - Current global rule.
 * @param unitId - Loja of the report request.
 * @returns New pairs only.
 */
export function quoteApprovalInserts(
  quotes: AttributionQuoteRow[],
  services: AttributionServiceRow[],
  existing: QuoteAttributionRow[],
  rule: { version: number; windowDays: number },
  unitId: string,
): QuoteAttributionRow[] {
  const claimedServices = new Set(existing.map((row) => row.serviceId));
  const seen = new Set(existing.map((row) => pairKey(row.serviceId, row.quoteId)));
  const inserts: QuoteAttributionRow[] = [];

  for (const quote of quotes) {
    if (quote.unitId !== unitId) {
      continue;
    }
    for (const service of services) {
      if (claimedServices.has(service.id)) {
        continue;
      }
      if (service.unitId !== unitId || !isOmieOrigin(service) || !service.performedAt) {
        continue;
      }
      if (service.customerId !== quote.customerId) {
        continue;
      }
      if (!inAttributionWindow(quote.createdAt, service.performedAt, rule.windowDays)) {
        continue;
      }
      const key = pairKey(service.id, quote.quoteId);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      claimedServices.add(service.id);
      inserts.push({
        serviceId: service.id,
        quoteId: quote.quoteId,
        ruleVersion: rule.version,
      });
      break;
    }
  }
  return inserts;
}

/**
 * Builds the `attribution` report section from persisted pairs (counts, not a fresh window re-check).
 *
 * @param rule - Current rule stated on the result (new evaluations); stored rows keep their versions.
 * @param services - Used to restrict REP-11 to Omie services in the period and unit.
 * @param scheduled - All scheduled-attribution rows (any version).
 * @param conversations - All conversation-attribution rows (any version).
 * @param novas - Linked novas in the cut (denominator).
 * @param unitId - Loja of the report request.
 * @param query - Period for REP-11 service dates.
 * @returns Typed `attribution` section for {@link ReportResult}.
 */
export function countAttribution(
  rule: { version: number; windowDays: number },
  services: AttributionServiceRow[],
  scheduled: ScheduledAttributionRow[],
  conversations: ConversationAttributionRow[],
  novas: ReportConversationRow[],
  unitId: string,
  query: ReportQuery,
): ReportResult["attribution"] {
  const periodStart = new Date(query.periodStart);
  const periodEnd = new Date(query.periodEnd);
  const servicesInPeriod = new Set(
    services
      .filter(
        (service) =>
          service.unitId === unitId &&
          isOmieOrigin(service) &&
          service.performedAt &&
          inHalfOpenPeriod(service.performedAt, periodStart, periodEnd),
      )
      .map((service) => service.id),
  );
  const scheduledServiceIds = new Set<string>();
  for (const row of scheduled) {
    if (servicesInPeriod.has(row.serviceId)) {
      scheduledServiceIds.add(row.serviceId);
    }
  }

  const novaIds = new Set(novas.map((row) => row.conversationId));
  const convertedIds = new Set<string>();
  for (const row of conversations) {
    if (novaIds.has(row.conversationId)) {
      convertedIds.add(row.conversationId);
    }
  }

  const sourceTypes: ConversationSourceType[] = ["AD", "ORGANIC", "UNKNOWN"];
  const bySource: ReportResult["attribution"]["conversion"]["bySource"] = [];
  for (const sourceType of sourceTypes) {
    const ofSource = novas.filter((row) => row.sourceType === sourceType);
    if (ofSource.length === 0) {
      continue;
    }
    bySource.push({
      sourceType,
      converted: ofSource.filter((row) => convertedIds.has(row.conversationId)).length,
      total: ofSource.length,
    });
  }

  return {
    rule,
    scheduledReturn: { count: scheduledServiceIds.size },
    conversion: {
      converted: convertedIds.size,
      total: novas.length,
      bySource,
    },
  };
}
