/**
 * Relatórios funnel / KPI / origin expansion built from a period result, its
 * services and interval rules: runs the current and the previous period, and
 * attaches the insights with their signed deltas.
 *
 * The one-period insights are in `period-insights.ts`, the customer figures in
 * `customer-figures.ts`; both were part of this file before the reports module
 * existed and split out by topic when it moved under the line cap.
 */
import { emptyReportInsights, type ReportInsights, type ReportKpi, type ReportQuery, type ReportResult } from "../contracts/http.js";
import type { IntervalRuleInput } from "../../services/contracts/http.js";
import { buildReport, type ReportConversationRow, type ReportScheduledRow } from "./aggregate.js";
import type {
  AttributionQuoteRow,
  AttributionServiceRow,
  ConversationAttributionRow,
  QuoteAttributionRow,
} from "./attribution.js";
import { churnAndLtv } from "./customer-figures.js";
import { buildPeriodInsights } from "./period-insights.js";

/**
 * Preceding equal-length period under the same filters.
 *
 * @param query - Current report query.
 * @returns A query whose window is `[periodStart − length, periodStart)`.
 */
export function previousPeriodQuery(query: ReportQuery): ReportQuery {
  const start = Date.parse(query.periodStart);
  const end = Date.parse(query.periodEnd);
  const length = end - start;
  return {
    ...query,
    periodStart: new Date(start - length).toISOString(),
    periodEnd: query.periodStart,
  };
}

function deltaPct(current: number | null, previous: number | null): number | undefined {
  if (previous == null || previous === 0 || current == null) {
    return undefined;
  }
  return ((current - previous) / previous) * 100;
}

function withDelta(value: number | null, previous: number | null): ReportKpi {
  const delta = deltaPct(value, previous);
  return delta === undefined ? { value } : { value, deltaPct: delta };
}

/**
 * Copies previous-period values onto the current insights as signed percent deltas.
 *
 * @param current - Insights for the selected period.
 * @param previous - Insights for the preceding equal-length period; omit deltas when leads were 0.
 * @returns Insights with `deltaPct` on primary KPIs when the previous value is non-zero.
 */
export function applyInsightDeltas(current: ReportInsights, previous: ReportInsights): ReportInsights {
  const previousHadData = (previous.primary.leads.value ?? 0) > 0;
  if (!previousHadData) {
    return current;
  }
  return {
    ...current,
    primary: {
      leads: withDelta(current.primary.leads.value, previous.primary.leads.value),
      conversionRate: withDelta(current.primary.conversionRate.value, previous.primary.conversionRate.value),
      revenue: withDelta(current.primary.revenue.value, previous.primary.revenue.value),
      meanFirstResponseMs: withDelta(
        current.primary.meanFirstResponseMs.value,
        previous.primary.meanFirstResponseMs.value,
      ),
    },
  };
}

/**
 * Runs the current and previous period aggregates and attaches funnel insights plus deltas.
 *
 * @param input - Rows, attributions, quotes, services and interval rules already scoped by the store.
 * @returns A {@link ReportResult} with `insights` filled.
 */
export function finishReport(input: {
  rows: ReportConversationRow[];
  unitId: string;
  query: ReportQuery;
  scheduled?: ReportScheduledRow[];
  now?: Date;
  attribution: ReportResult["attribution"];
  previousAttribution: ReportResult["attribution"];
  services: AttributionServiceRow[];
  quotes: AttributionQuoteRow[];
  quoteAttributions: QuoteAttributionRow[];
  conversationAttributions: ConversationAttributionRow[];
  unansweredQuotes: number;
  rules: IntervalRuleInput[];
}): ReportResult {
  const now = input.now ?? new Date();
  const current = buildReport(input.rows, input.unitId, input.query, {
    scheduled: input.scheduled,
    now,
    attribution: input.attribution,
  });
  const previousQuery = previousPeriodQuery(input.query);
  const previous = buildReport(input.rows, input.unitId, previousQuery, {
    scheduled: input.scheduled,
    now,
    attribution: input.previousAttribution,
  });
  const currentLapsed = churnAndLtv(
    input.services,
    input.unitId,
    input.rules,
    new Date(input.query.periodStart),
    new Date(input.query.periodEnd),
  );
  const previousLapsed = churnAndLtv(
    input.services,
    input.unitId,
    input.rules,
    new Date(previousQuery.periodStart),
    new Date(previousQuery.periodEnd),
  );
  const currentInsights = buildPeriodInsights({
    rows: input.rows,
    unitId: input.unitId,
    query: input.query,
    result: current,
    services: input.services,
    quotes: input.quotes,
    quoteAttributions: input.quoteAttributions,
    conversationAttributions: input.conversationAttributions,
    unansweredQuotes: input.unansweredQuotes,
    customers: currentLapsed,
  });
  const previousInsights = buildPeriodInsights({
    rows: input.rows,
    unitId: input.unitId,
    query: previousQuery,
    result: previous,
    services: input.services,
    quotes: input.quotes,
    quoteAttributions: input.quoteAttributions,
    conversationAttributions: input.conversationAttributions,
    unansweredQuotes: input.unansweredQuotes,
    customers: previousLapsed,
  });
  return { ...current, insights: applyInsightDeltas(currentInsights, previousInsights) };
}

export { emptyReportInsights };
