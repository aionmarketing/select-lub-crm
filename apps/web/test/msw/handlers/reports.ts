import { http, HttpResponse } from "msw";
import { emptyReportInsights, type ReportResult } from "@select-lub/shared-types";

const emptyReport: ReportResult = {
  query: {
    periodStart: "2026-08-01T03:00:00.000Z",
    periodEnd: "2026-09-01T03:00:00.000Z",
    granularity: "day",
  },
  buckets: [],
  newConversationCount: 0,
  activeConversationCount: 0,
  firstResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
  },
  coverage: { answered: 0, total: 0 },
  unanswered: { count: 0, items: [] },
  subsequentResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
    inboundTotal: 0,
  },
  respondedRate: { answered: 0, total: 0 },
  byTag: [],
  byCampaign: [],
  scheduled: { scheduled: 0, sent: 0, cancelled: 0, failed: 0 },
  attribution: {
    rule: { windowDays: 30, version: 1 },
    scheduledReturn: { count: 0 },
    conversion: { converted: 0, total: 0, bySource: [] },
  },
  insights: emptyReportInsights(),
};

export const reportsHandlers = [
  http.get("*/api/reports/conversations", () => HttpResponse.json(emptyReport)),
];
