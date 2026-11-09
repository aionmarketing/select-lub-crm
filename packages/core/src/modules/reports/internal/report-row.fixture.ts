/**
 * Test fixtures shared by the `buildReport` suites: two unit ids, the August
 * 2026 query and its bounds, and factories for a conversation row and a
 * message. Test-only; nothing in production imports it.
 *
 * Moved from the top of `apps/api/src/reports/aggregate.test.ts`, unchanged,
 * when that file split in two under the line cap.
 */
import type { ReportConversationRow } from "./aggregate.js";

export const unitA = "unit-a";
export const unitB = "unit-b";

export const aug2026Query = {
  periodStart: "2026-08-01T03:00:00.000Z",
  periodEnd: "2026-09-01T03:00:00.000Z",
  granularity: "day" as const,
};

export const start = new Date("2026-08-01T03:00:00.000Z");
export const end = new Date("2026-09-01T03:00:00.000Z");

/** A conversation row in unit A, UNKNOWN origin, no messages, overridable per test. */
export function row(
  partial: Partial<ReportConversationRow> & Pick<ReportConversationRow, "firstInboundAt">,
): ReportConversationRow {
  return {
    conversationId: partial.conversationId ?? `conv-${partial.firstInboundAt?.toISOString() ?? "none"}`,
    unitId: unitA,
    sourceType: "UNKNOWN",
    firstOutboundAt: null,
    campaignId: null,
    adSetId: null,
    adId: null,
    tags: [],
    messages: [],
    customerId: null,
    ...partial,
  };
}

/** One message; `shouldReply` is omitted when not given, as the loader omits it. */
export function msg(direction: "inbound" | "outbound", iso: string, shouldReply?: boolean) {
  return { direction, providerTimestamp: new Date(iso), ...(shouldReply === undefined ? {} : { shouldReply }) };
}
