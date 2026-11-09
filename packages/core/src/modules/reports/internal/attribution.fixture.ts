/**
 * Fixtures shared by the attribution suites: the August 2026 query, two rule
 * versions, a service date, and factories for an Omie service, a SENT anchor
 * and a nova. Test-only; nothing in production imports it.
 *
 * Moved from the top of `apps/api/src/reports/attribution.test.ts`, unchanged
 * except for the `export`s, when that file split in three under the line cap.
 */
import type { ReportConversationRow } from "./aggregate.js";
import type { AttributionScheduledAnchor, AttributionServiceRow } from "./attribution.js";

export const query = {
  periodStart: "2026-08-01T03:00:00.000Z",
  periodEnd: "2026-09-01T03:00:00.000Z",
  granularity: "day" as const,
};

export const ruleV1 = { version: 1, windowDays: 30 };
export const ruleV2 = { version: 2, windowDays: 10 };

export const performed = new Date("2026-08-20T12:00:00.000Z");

/** An Omie-origin service in unit A for cust-1 / veh-1, performed on `performed`. */
export function omieService(partial: Partial<AttributionServiceRow> & Pick<AttributionServiceRow, "id">): AttributionServiceRow {
  return {
    unitId: "unit-a",
    customerId: "cust-1",
    vehicleId: "veh-1",
    omieId: "omie-os-1",
    origin: "omie",
    performedAt: performed,
    amount: 180,
    ...partial,
  };
}

/** A SENT anchor in unit A for cust-1 / veh-1. */
export function sentAnchor(
  partial: Partial<AttributionScheduledAnchor> & Pick<AttributionScheduledAnchor, "id" | "sentAt">,
): AttributionScheduledAnchor {
  return {
    unitId: "unit-a",
    status: "SENT",
    customerId: "cust-1",
    referenceVehicleId: "veh-1",
    ...partial,
  };
}

/** An ORGANIC nova in unit A for cust-1, first inbound 2026-08-08. */
export function nova(partial: Partial<ReportConversationRow> & Pick<ReportConversationRow, "conversationId">): ReportConversationRow {
  return {
    unitId: "unit-a",
    sourceType: "ORGANIC",
    firstInboundAt: new Date("2026-08-08T12:00:00.000Z"),
    firstOutboundAt: null,
    campaignId: null,
    adSetId: null,
    adId: null,
    tags: [],
    messages: [],
    customerId: "cust-1",
    ...partial,
  };
}
