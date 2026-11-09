/**
 * Test design (testing-strategy)
 *
 * Setup: pure functions in insights.ts. No HTTP, no Prisma.
 *
 * Oracle: relatorios-funnel-insights — primary KPIs + equal-length deltas
 * (absent when previous is 0); approval absent at zero quotes; funnel
 * nested subsets 100/80/30/12; origin exactly three rows; lapsed customers and
 * average revenue follow the period (both absent when nobody had a service in it); return date = Follow-up suggestDate / +6 months.
 *
 * Axes
 *   A1 previous period — 10 leads / 0 leads
 *   A2 quotes in period — 0 / 1 approved
 *   A3 funnel nesting — 100/80/30/12
 *   A4 origin — AD / ORGANIC / UNKNOWN
 *   A5 lapse timing — due inside the period / before it / moved past it by a newer service; revenue over the period's customers only
 *   A6 (align-shipped-ui-to-pdf-artboards) customer counts — 7 lapsed of 39
 *      with a service, 32 served in the period / nobody served (all null)
 *
 * Outputs: O1 deltaPct; O2 omitted delta; O3 null approval; O4 funnel; O5 origin; O6 churn;
 *   O7 the three counts beside the rates, copied unchanged onto insights.secondary
 *
 * Decision map (churnAndLtv): `inPeriod.size === 0` — T: absent-values it and
 * the other-unit it (nulls for all five); F: every counting it. The
 * `rows.filter(isOmieOrigin)` in the revenue sum is one-sided here (every
 * fixture service is Omie-origin) — the crm-origin exclusion is covered by
 * attribution.test.ts, which owns `isOmieOrigin`'s inputs.
 *
 * Added (align-shipped-ui-to-pdf-artboards, downstream-invariant check):
 * `inPeriod.size === 0` gates all five return fields together by
 * construction (inPeriod is a filtered subset of byCustomer, so one can
 * only be empty without the other being empty too) — pinned directly so a
 * downstream reader's "lapsedCustomers non-null / customersWithService
 * falsy is infeasible" claim has a producer-side test, not just a comment.
 *
 * Split from `apps/api/src/reports/insights.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Sibling:
 * customer-figures.test.ts. Pure: runs under no module role.
 */
import { describe, expect, it } from "vitest";
import { emptyReportInsights, type ReportResult } from "../contracts/http.js";
import type { ReportConversationRow } from "./aggregate.js";
import { applyInsightDeltas, previousPeriodQuery } from "./insights.js";
import { buildPeriodInsights } from "./period-insights.js";

const query = {
  periodStart: "2026-08-01T03:00:00.000Z",
  periodEnd: "2026-08-15T03:00:00.000Z",
  granularity: "day" as const,
};

function resultStub(partial: Partial<ReportResult> = {}): ReportResult {
  return {
    query,
    buckets: [],
    newConversationCount: 0,
    activeConversationCount: 0,
    firstResponse: { meanMs: 1000, medianMs: 1000, p90Ms: 1000, eligibleCount: 1 },
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
    ...partial,
  };
}

function row(
  partial: Partial<ReportConversationRow> & Pick<ReportConversationRow, "conversationId" | "firstInboundAt">,
): ReportConversationRow {
  return {
    unitId: "unit-a",
    sourceType: "UNKNOWN",
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

describe("previousPeriodQuery and applyInsightDeltas", () => {
  it("computes a +100% leads delta against an equal-length previous period", () => {
    expect(previousPeriodQuery(query)).toEqual({
      ...query,
      periodStart: "2026-07-18T03:00:00.000Z",
      periodEnd: "2026-08-01T03:00:00.000Z",
    });
    const current = emptyReportInsights();
    current.primary.leads = { value: 20 };
    const previous = emptyReportInsights();
    previous.primary.leads = { value: 10 };

    expect(applyInsightDeltas(current, previous).primary.leads.deltaPct).toBe(100);
  });

  it("omits the delta when the previous period has no leads", () => {
    const current = emptyReportInsights();
    current.primary.leads = { value: 20 };
    const previous = emptyReportInsights();

    expect(applyInsightDeltas(current, previous).primary.leads.deltaPct).toBeUndefined();
  });
});

describe("buildPeriodInsights", () => {
  it("nests the funnel as 100 / 80 / 30 / 12", () => {
    const rows: ReportConversationRow[] = [];
    const quotes = [];
    const conversationAttributions = [];
    for (let i = 0; i < 100; i += 1) {
      const conversationId = `c-${i}`;
      rows.push(
        row({
          conversationId,
          firstInboundAt: new Date("2026-08-05T12:00:00.000Z"),
          firstOutboundAt: i < 80 ? new Date("2026-08-05T13:00:00.000Z") : null,
          customerId: `cust-${i}`,
        }),
      );
      if (i < 30) {
        quotes.push({
          quoteId: `q-${i}`,
          conversationId,
          customerId: `cust-${i}`,
          unitId: "unit-a",
          createdAt: new Date("2026-08-06T12:00:00.000Z"),
        });
      }
      if (i < 12) {
        conversationAttributions.push({
          serviceId: `svc-${i}`,
          conversationId,
          ruleVersion: 1,
        });
      }
    }

    const insights = buildPeriodInsights({
      rows,
      unitId: "unit-a",
      query,
      result: resultStub({
        attribution: {
          rule: { windowDays: 30, version: 1 },
          scheduledReturn: { count: 0 },
          conversion: { converted: 12, total: 100, bySource: [] },
        },
      }),
      services: [],
      quotes,
      quoteAttributions: [],
      conversationAttributions,
      unansweredQuotes: 0,
      customers: {
        churnRate: null,
        ltv: null,
        lapsedCustomers: null,
        customersWithService: null,
        customersServedInPeriod: null,
      },
    });

    expect(insights.funnel).toEqual({
      novosContatos: 100,
      emAtendimento: 80,
      orcamentoEnviado: 30,
      servicosFeitos: 12,
    });
  });

  it("returns exactly three origin rows and a null approval rate when no quotes were sent", () => {
    const insights = buildPeriodInsights({
      rows: [
        row({
          conversationId: "c-ad",
          sourceType: "AD",
          firstInboundAt: new Date("2026-08-05T12:00:00.000Z"),
        }),
      ],
      unitId: "unit-a",
      query,
      result: resultStub(),
      services: [],
      quotes: [],
      quoteAttributions: [],
      conversationAttributions: [],
      unansweredQuotes: 4,
      customers: {
        churnRate: 0.2,
        ltv: 450,
        lapsedCustomers: 2,
        customersWithService: 10,
        customersServedInPeriod: 4,
      },
    });

    expect(insights.originRows.map((row) => row.origin)).toEqual(["AD", "ORGANIC", "UNKNOWN"]);
    expect(insights.secondary.approvalRate).toBeNull();
    expect(insights.secondary.unansweredQuotes).toBe(4);
    expect(insights.originRows).toHaveLength(3);
    // The customer figures are copied through untouched — the screen prints
    // the counts beside the rates, so a rounding here would be a lie there.
    expect(insights.secondary).toMatchObject({
      churnRate: 0.2,
      ltv: 450,
      lapsedCustomers: 2,
      customersWithService: 10,
      customersServedInPeriod: 4,
    });
  });
});
