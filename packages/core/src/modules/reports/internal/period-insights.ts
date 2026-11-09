/**
 * One period's insights: the primary KPIs, the secondary figures, the REP-15
 * funnel and the three origin rows — before any previous-period delta.
 *
 * Moved from `apps/api/src/reports/insights.ts` when that file split by topic
 * under the line cap. The funnel itself, and the nova predicate it rests on,
 * are the published rule in `../contracts/funnel.ts`; this file calls them
 * rather than holding a second copy, so the numbers the conversations module
 * is tested against are the numbers drawn here.
 */
import type { ReportInsights, ReportQuery, ReportResult } from "../contracts/http.js";
import { isNovaInPeriod, reportFunnel } from "../contracts/funnel.js";
import type { ReportConversationRow } from "./aggregate.js";
import type {
  AttributionQuoteRow,
  AttributionServiceRow,
  ConversationAttributionRow,
  QuoteAttributionRow,
} from "./attribution.js";
import { inHalfOpenPeriod } from "./calendar.js";
import type { churnAndLtv } from "./customer-figures.js";
import { amountOf, isOmieOrigin } from "./service-revenue.js";

/**
 * Builds period insights (funnel, origin, approval) without previous-period deltas.
 *
 * @param input - Current cut rows, attribution pairs, quotes, and the period's customer figures from {@link churnAndLtv}.
 * @returns Insights with primary values and no `deltaPct`.
 */
export function buildPeriodInsights(input: {
  rows: ReportConversationRow[];
  unitId: string;
  query: ReportQuery;
  result: ReportResult;
  services: AttributionServiceRow[];
  quotes: AttributionQuoteRow[];
  quoteAttributions: QuoteAttributionRow[];
  conversationAttributions: ConversationAttributionRow[];
  unansweredQuotes: number;
  customers: ReturnType<typeof churnAndLtv>;
}): ReportInsights {
  const periodStart = new Date(input.query.periodStart);
  const periodEnd = new Date(input.query.periodEnd);
  const novas = input.rows.filter((row) =>
    isNovaInPeriod(row, input.unitId, periodStart, periodEnd),
  );
  const novaIds = new Set(novas.map((row) => row.conversationId));
  const convertedIds = new Set(
    input.conversationAttributions
      .filter((row) => novaIds.has(row.conversationId))
      .map((row) => row.conversationId),
  );
  const quotesInPeriod = input.quotes.filter(
    (quote) =>
      quote.unitId === input.unitId && inHalfOpenPeriod(quote.createdAt, periodStart, periodEnd),
  );
  const approvedQuoteIds = new Set(
    input.quoteAttributions
      .filter((row) => quotesInPeriod.some((quote) => quote.quoteId === row.quoteId))
      .map((row) => row.quoteId),
  );
  const serviceById = new Map(input.services.map((service) => [service.id, service]));
  const attributedServiceIds = new Set(
    input.conversationAttributions
      .filter((row) => novaIds.has(row.conversationId))
      .map((row) => row.serviceId),
  );
  let revenue = 0;
  for (const serviceId of attributedServiceIds) {
    const service = serviceById.get(serviceId);
    if (!service || !service.performedAt || !isOmieOrigin(service)) {
      continue;
    }
    if (!inHalfOpenPeriod(service.performedAt, periodStart, periodEnd)) {
      continue;
    }
    revenue += amountOf(service);
  }

  const conversionTotal = input.result.attribution.conversion.total;
  const conversionRate =
    conversionTotal === 0 ? null : input.result.attribution.conversion.converted / conversionTotal;
  const approvalRate =
    quotesInPeriod.length === 0 ? null : approvedQuoteIds.size / quotesInPeriod.length;

  const origins = ["AD", "ORGANIC", "UNKNOWN"] as const;
  const originRows = origins.map((origin) => {
    const ofOrigin = novas.filter((row) => row.sourceType === origin);
    const conversions = ofOrigin.filter((row) => convertedIds.has(row.conversationId)).length;
    let originRevenue = 0;
    for (const row of ofOrigin) {
      for (const attr of input.conversationAttributions) {
        if (attr.conversationId !== row.conversationId) {
          continue;
        }
        const service = serviceById.get(attr.serviceId);
        if (!service || !service.performedAt || !isOmieOrigin(service)) {
          continue;
        }
        if (!inHalfOpenPeriod(service.performedAt, periodStart, periodEnd)) {
          continue;
        }
        originRevenue += amountOf(service);
      }
    }
    return {
      origin,
      leads: ofOrigin.length,
      conversions,
      conversionRate: ofOrigin.length === 0 ? null : conversions / ofOrigin.length,
      revenue: originRevenue,
    };
  });

  return {
    primary: {
      leads: { value: novas.length },
      conversionRate: { value: conversionRate },
      revenue: { value: revenue },
      meanFirstResponseMs: { value: input.result.firstResponse.meanMs },
    },
    secondary: {
      unanswered: input.result.unanswered.count,
      unansweredQuotes: input.unansweredQuotes,
      approvalRate,
      churnRate: input.customers.churnRate,
      ltv: input.customers.ltv,
      lapsedCustomers: input.customers.lapsedCustomers,
      customersWithService: input.customers.customersWithService,
      customersServedInPeriod: input.customers.customersServedInPeriod,
    },
    funnel: reportFunnel({
      rows: input.rows,
      unitId: input.unitId,
      periodStart,
      periodEnd,
      quotes: input.quotes,
      conversationAttributions: input.conversationAttributions,
    }),
    originRows,
  };
}
