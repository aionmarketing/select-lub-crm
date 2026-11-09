/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on Relatórios query and result schemas. No HTTP.
 *
 * Oracle: openspec/changes/relatorios-remainder-metrics/specs/shared-types/spec.md
 *   + relatorios/spec.md — shared contract; invalid query rejected; result
 *   with empty scheduled + null subsequent parses; attribution (REP-11/12)
 *   is required on the result.
 *
 * Techniques: EP (one invalid class per `it`), BVA on period order
 * (start < end / start === end / start > end), decision coverage of
 * reportQuerySchema.superRefine.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 periodStart / periodEnd parseability
 *   EP valid: ISO instants Date.parse finite
 *   EP invalid (own `it`s): unparseable start; unparseable end; "" (min(1),
 *     fails before superRefine)
 *   BVA: not an ordered numeric cutoff beyond Date.parse NaN vs finite
 *
 * A2 period order (only after both parse)
 *   EP valid: start < end; start === end (not "after")
 *   EP invalid: start > end
 *   BVA: start === end (edge), start > end (invalid side)
 *
 * A3 granularity
 *   EP valid: day | week | month (sampled week)
 *   EP invalid: "quarter" (own `it`)
 *
 * A4 sourceType
 *   EP valid: omitted (todas); AD | ORGANIC | UNKNOWN
 *   EP invalid: "PAID" (own `it`)
 *
 * A5 tagId / campaignId
 *   EP valid: omitted; non-empty string
 *   EP invalid: "" (own `it`s, min(1))
 *
 * A6 result payload
 *   EP valid: novas + stats; empty scheduled + null subsequent
 *   EP invalid: 101 unanswered items (max 100); negative newConversationCount
 *     (client parse file)
 *
 * A7 insights.secondary customer counts (align-shipped-ui-to-pdf-artboards)
 *   EP valid: the three counts as integers; all three null (empty period)
 *   EP invalid (own `it`s): a count missing (older API); a negative count
 *   BVA: 0 is a valid count (nonnegative); -1 the invalid side
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * | `it`                                      | axes        | Out | fails if |
 * | parses without sourceType (todas)         | A4 omitted  | O1  | throws or sourceType invented |
 * | parses with sourceType AD                 | A4 AD       | O1  | throws |
 * | parses with tagId and campaignId          | A5 valid    | O1  | throws |
 * | periodStart === periodEnd                 | A2 edge     | O1  | rejected as after |
 * | periodStart after periodEnd               | A2 invalid  | O2  | success true |
 * | unknown granularity                       | A3 invalid  | O2  | success true |
 * | unknown sourceType                        | A4 invalid  | O2  | success true |
 * | empty tagId                               | A5 invalid  | O2  | success true |
 * | empty campaignId                          | A5 invalid  | O2  | success true |
 * | unparseable periodStart                   | A1 invalid  | O2  | success true |
 * | unparseable periodEnd                     | A1 invalid  | O2  | success true |
 * | empty periodStart                         | A1 min(1)   | O2  | success true |
 * | valid result with stats                   | A6 valid    | O1  | throws |
 * | empty scheduled + null subsequent         | A6 empty    | O1  | throws |
 * | 101 unanswered items                      | A6 invalid  | O2  | success true |
 * | customer counts as integers               | A7 valid    | O1  | throws or counts dropped |
 * | customer counts null together             | A7 valid    | O1  | throws |
 * | customer count missing                    | A7 invalid  | O2  | success true (old API accepted) |
 * | negative customer count                   | A7 invalid  | O2  | success true |
 *
 * ----------------------------------------------------------------------------
 * Decision map (superRefine)
 * ----------------------------------------------------------------------------
 * D1 Number.isNaN(start) || Number.isNaN(end)
 *   T start: unparseable periodStart; T end: unparseable periodEnd
 *   F: every successful parse
 * D2 start > end (only after D1 F)
 *   T: periodStart after periodEnd; F: start < end and start === end
 *
 * Short-circuit: both NaN takes D1 T with path periodStart (start checked first).
 * Not sampled as its own `it` — same D1 T as unparseable start.
 *
 * Out of scope: HTTP 400 (reports.route.test.ts); UI empty copy (RelatoriosPage).
 */

import { describe, expect, it } from "vitest";
import { emptyReportInsights, reportQuerySchema, reportResultSchema } from "./http.reports.js";

const validQuery = {
  periodStart: "2026-08-01T03:00:00.000Z",
  periodEnd: "2026-09-01T03:00:00.000Z",
  granularity: "week" as const,
};

const emptyScheduled = {
  scheduled: 0,
  sent: 0,
  cancelled: 0,
  failed: 0,
};

const emptyAttribution = {
  rule: { windowDays: 30, version: 1 },
  scheduledReturn: { count: 0 },
  conversion: { converted: 0, total: 0, bySource: [] as { sourceType: "AD" | "ORGANIC" | "UNKNOWN"; converted: number; total: number }[] },
};

const nullSubsequent = {
  meanMs: null,
  medianMs: null,
  p90Ms: null,
  eligibleCount: 0,
  inboundTotal: 0,
};

const validResult = {
  query: validQuery,
  buckets: [
    {
      bucketStart: "2026-08-03T03:00:00.000Z",
      newConversationCount: 2,
      activeConversationCount: 2,
    },
  ],
  newConversationCount: 2,
  activeConversationCount: 2,
  firstResponse: {
    meanMs: 1000,
    medianMs: 1000,
    p90Ms: 1000,
    eligibleCount: 1,
  },
  coverage: { answered: 1, total: 2 },
  unanswered: { count: 0, items: [] },
  subsequentResponse: {
    meanMs: 1000,
    medianMs: 1000,
    p90Ms: 1000,
    eligibleCount: 1,
    inboundTotal: 2,
  },
  respondedRate: { answered: 1, total: 2 },
  byTag: [],
  byCampaign: [],
  scheduled: emptyScheduled,
  attribution: emptyAttribution,
  insights: emptyReportInsights(),
};

describe("reportQuerySchema", () => {
  it("parses a query without sourceType (todas)", () => {
    expect(reportQuerySchema.parse(validQuery)).toEqual(validQuery);
  });

  it("parses a query with sourceType AD", () => {
    const query = { ...validQuery, sourceType: "AD" as const };

    expect(reportQuerySchema.parse(query)).toEqual(query);
  });

  it("parses a query with tagId and campaignId", () => {
    const query = { ...validQuery, tagId: "tag-1", campaignId: "camp-1" };

    expect(reportQuerySchema.parse(query)).toEqual(query);
  });

  it("parses when periodStart equals periodEnd", () => {
    const query = {
      ...validQuery,
      periodStart: "2026-08-01T03:00:00.000Z",
      periodEnd: "2026-08-01T03:00:00.000Z",
    };

    expect(reportQuerySchema.parse(query)).toEqual(query);
  });

  it("rejects when periodStart is after periodEnd", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      periodStart: "2026-09-01T03:00:00.000Z",
      periodEnd: "2026-08-01T03:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown granularity", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      granularity: "quarter",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unknown sourceType", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      sourceType: "PAID",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty tagId", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      tagId: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty campaignId", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      campaignId: "",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unparseable periodStart", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      periodStart: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unparseable periodEnd", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      periodEnd: "not-a-date",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty periodStart", () => {
    const result = reportQuerySchema.safeParse({
      ...validQuery,
      periodStart: "",
    });

    expect(result.success).toBe(false);
  });
});

describe("reportResultSchema", () => {
  it("parses a valid report result with stats", () => {
    expect(reportResultSchema.parse(validResult)).toEqual(validResult);
  });

  it("parses empty scheduled counts and null subsequent stats", () => {
    const empty = {
      query: validQuery,
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
      subsequentResponse: nullSubsequent,
      respondedRate: { answered: 0, total: 0 },
      byTag: [],
      byCampaign: [],
      scheduled: emptyScheduled,
      attribution: emptyAttribution,
      insights: emptyReportInsights(),
    };

    expect(reportResultSchema.parse(empty)).toEqual(empty);
  });

  it("rejects a result with 101 unanswered items", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      conversationId: `c-${i}`,
      waitMs: i,
    }));

    const result = reportResultSchema.safeParse({
      ...validResult,
      unanswered: { count: 101, items },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a result missing the attribution section", () => {
    const { attribution: _dropped, ...withoutAttribution } = validResult;
    void _dropped;

    expect(reportResultSchema.safeParse(withoutAttribution).success).toBe(false);
  });

  it("rejects a result missing insights", () => {
    const { insights: _dropped, ...withoutInsights } = validResult;
    void _dropped;

    expect(reportResultSchema.safeParse(withoutInsights).success).toBe(false);
  });

  it("parses a result that omits deltaPct on primary KPIs", () => {
    expect(reportResultSchema.parse(validResult).insights.primary.leads.deltaPct).toBeUndefined();
  });

  it("rejects a funnel with a negative stage count", () => {
    const result = reportResultSchema.safeParse({
      ...validResult,
      insights: {
        ...validResult.insights,
        funnel: { ...validResult.insights.funnel, novosContatos: -1 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("parses the three customer counts beside the rates", () => {
    const secondary = {
      ...validResult.insights.secondary,
      churnRate: 7 / 39,
      ltv: 320,
      lapsedCustomers: 7,
      customersWithService: 39,
      customersServedInPeriod: 32,
    };

    const parsed = reportResultSchema.parse({
      ...validResult,
      insights: { ...validResult.insights, secondary },
    });

    expect(parsed.insights.secondary).toEqual(secondary);
  });

  it("parses the customer counts as null together with the rates on an empty period", () => {
    const parsed = reportResultSchema.parse(validResult);

    expect(parsed.insights.secondary).toMatchObject({
      churnRate: null,
      ltv: null,
      lapsedCustomers: null,
      customersWithService: null,
      customersServedInPeriod: null,
    });
  });

  it("rejects a result whose secondary KPIs omit a customer count", () => {
    const { customersWithService: _dropped, ...withoutBase } = validResult.insights.secondary;
    void _dropped;

    const result = reportResultSchema.safeParse({
      ...validResult,
      insights: { ...validResult.insights, secondary: withoutBase },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a negative lapsed-customer count", () => {
    const result = reportResultSchema.safeParse({
      ...validResult,
      insights: {
        ...validResult.insights,
        secondary: { ...validResult.insights.secondary, lapsedCustomers: -1 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects originRows that are not exactly three", () => {
    const result = reportResultSchema.safeParse({
      ...validResult,
      insights: {
        ...validResult.insights,
        originRows: validResult.insights.originRows.slice(0, 2),
      },
    });

    expect(result.success).toBe(false);
  });
});
