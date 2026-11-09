/**
 * Zod contracts for the Relatórios dashboard query parameters and aggregated metrics response.
 *
 * Moved from `packages/shared-types/src/reports.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** How a conversation entered the CRM: paid ad, organic WhatsApp, or unknown. */
export const conversationSourceTypeSchema = z.enum(["AD", "ORGANIC", "UNKNOWN"]);

/** Time bucket width for volume charts in the reports response. */
export const reportGranularitySchema = z.enum(["day", "week", "month"]);

const isoInstant = z.string().min(1);

/** Query string for `GET /reports`; `periodStart` must not be after `periodEnd`. */
export const reportQuerySchema = z
  .object({
    periodStart: isoInstant,
    periodEnd: isoInstant,
    granularity: reportGranularitySchema,
    sourceType: conversationSourceTypeSchema.optional(),
    tagId: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
  })
  .superRefine((query, ctx) => {
    const start = Date.parse(query.periodStart);
    const end = Date.parse(query.periodEnd);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      ctx.addIssue({
        code: "custom",
        message: "periodStart and periodEnd must be parseable instants",
        path: Number.isNaN(start) ? ["periodStart"] : ["periodEnd"],
      });
      return;
    }
    if (start > end) {
      ctx.addIssue({
        code: "custom",
        message: "periodStart must not be after periodEnd",
        path: ["periodStart"],
      });
    }
  });

/** One time bucket in the volume chart with new and active conversation counts. */
export const reportBucketSchema = z.object({
  bucketStart: isoInstant,
  newConversationCount: z.number().int().nonnegative(),
  activeConversationCount: z.number().int().nonnegative(),
});

/** First-reply latency distribution in milliseconds; null stats mean no eligible conversations. */
export const firstResponseStatsSchema = z.object({
  meanMs: z.number().nullable(),
  medianMs: z.number().nullable(),
  p90Ms: z.number().nullable(),
  eligibleCount: z.number().int().nonnegative(),
});

/** Subsequent-reply latency stats, including total inbound messages in the period. */
export const subsequentResponseStatsSchema = firstResponseStatsSchema.extend({
  inboundTotal: z.number().int().nonnegative(),
});

/** Answered-vs-total pair used for coverage and responded-rate metrics. */
export const reportCoverageSchema = z.object({
  answered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** One conversation still awaiting a first outbound reply, with wait time in milliseconds. */
export const unansweredItemSchema = z.object({
  conversationId: z.string().min(1),
  waitMs: z.number().nonnegative(),
});

/** Unanswered queue summary; `items` is capped at 100 rows for the dashboard preview. */
export const unansweredSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(unansweredItemSchema).max(100),
});

/** Conversation count grouped by tag for the reports breakdown table. */
export const reportByTagRowSchema = z.object({
  tagId: z.string().min(1),
  name: z.string(),
  count: z.number().int().nonnegative(),
});

/** Conversation count grouped by Meta ad campaign hierarchy for the reports breakdown table. */
export const reportByCampaignRowSchema = z.object({
  campaignId: z.string().min(1),
  adSetId: z.string().nullable(),
  adId: z.string().nullable(),
  count: z.number().int().nonnegative(),
});

/** Scheduled-message outbox counts by terminal state for the reports period. */
export const reportScheduledCountsSchema = z.object({
  scheduled: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Global attribution-rule snapshot stated on the report (window and version in use). */
export const reportAttributionRuleSchema = z.object({
  windowDays: z.number().int().positive(),
  version: z.number().int().positive(),
});

/** REP-12 converted/total pair broken down by conversation `sourceType`. */
export const reportAttributionBySourceSchema = z.object({
  sourceType: conversationSourceTypeSchema,
  converted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** REP-11 scheduled-return count and REP-12 conversion of linked novas. */
export const reportAttributionSchema = z.object({
  rule: reportAttributionRuleSchema,
  scheduledReturn: z.object({ count: z.number().int().nonnegative() }),
  conversion: z.object({
    converted: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    bySource: z.array(reportAttributionBySourceSchema),
  }),
});

/** One primary KPI: numeric value plus an optional signed percent vs the previous equal-length period. */
export const reportKpiSchema = z.object({
  value: z.number().nullable(),
  deltaPct: z.number().optional(),
});

/**
 * The furthest point a conversation has reached in REP-15's funnel.
 *
 * The values are the funnel's own key names on purpose: a Relatórios stage
 * that links into the inbox passes its key straight through as the filter
 * value, with nothing in between to translate — and nothing to get wrong.
 *
 * The stage is DERIVED, never stored and never settable. A stored stage can
 * drift from the funnel that defines it, and Relatórios is the reading users
 * trust.
 */
export const conversationPipelineStageSchema = z.enum([
  "novosContatos",
  "emAtendimento",
  "orcamentoEnviado",
  "servicosFeitos",
]);

/**
 * The stages in funnel order, least to most advanced.
 *
 * The funnel's counts are cumulative — `emAtendimento` counts every
 * conversation that reached that point OR further — so a count is the number
 * of conversations whose stage sits at this index or later. Grouping by stage
 * and nesting by rank are then the same arithmetic, which is what makes the
 * inbox and the report unable to disagree.
 */
export const CONVERSATION_PIPELINE_STAGES = [
  "novosContatos",
  "emAtendimento",
  "orcamentoEnviado",
  "servicosFeitos",
] as const;

/**
 * The furthest funnel point a conversation has reached, from the three events
 * REP-15 counts.
 *
 * The one implementation of the rule: `buildPeriodInsights` derives its funnel
 * counts from this, and the conversation read shape carries its result, so a
 * stage shown on a thread and a stage counted in a report cannot come apart.
 *
 * The events nest, exactly as the funnel nests them — a quote sent on a
 * conversation the team never replied to leaves the conversation at
 * `novosContatos`, because REP-15 filters `orcamentoEnviado` out of
 * `emAtendimento` rather than out of the whole cut.
 *
 * @param facts.hasTeamReply - Whether an outbound message exists (`firstOutboundAt` is set).
 * @param facts.hasQuoteSent - Whether an oil quote names this conversation.
 * @param facts.hasServiceAttributed - Whether a conversation-to-service attribution row names it.
 * @returns One of the four stages.
 */
export function conversationPipelineStage(facts: {
  hasTeamReply: boolean;
  hasQuoteSent: boolean;
  hasServiceAttributed: boolean;
}): ConversationPipelineStage {
  if (!facts.hasTeamReply) {
    return "novosContatos";
  }
  if (!facts.hasQuoteSent) {
    return "emAtendimento";
  }
  return facts.hasServiceAttributed ? "servicosFeitos" : "orcamentoEnviado";
}

/**
 * Whether a stage has reached at least `floor` in funnel order.
 *
 * @param stage - A conversation's derived stage.
 * @param floor - The funnel level being counted.
 * @returns True when `stage` sits at `floor`'s index or later, which is what a cumulative funnel count means.
 */
export function pipelineStageReached(
  stage: ConversationPipelineStage,
  floor: ConversationPipelineStage,
): boolean {
  return CONVERSATION_PIPELINE_STAGES.indexOf(stage) >= CONVERSATION_PIPELINE_STAGES.indexOf(floor);
}

/** Four nested funnel stage counts (each a subset of the previous). */
export const reportFunnelSchema = z.object({
  novosContatos: z.number().int().nonnegative(),
  emAtendimento: z.number().int().nonnegative(),
  orcamentoEnviado: z.number().int().nonnegative(),
  servicosFeitos: z.number().int().nonnegative(),
});

/** One origin-table row: leads, conversion, and attributed revenue. */
export const reportOriginRowSchema = z.object({
  origin: conversationSourceTypeSchema,
  leads: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  conversionRate: z.number().nullable(),
  revenue: z.number(),
});

/** Funnel / KPI / origin expansion consumed by the Relatórios card layout. */
export const reportInsightsSchema = z.object({
  primary: z.object({
    leads: reportKpiSchema,
    conversionRate: reportKpiSchema,
    revenue: reportKpiSchema,
    meanFirstResponseMs: reportKpiSchema,
  }),
  secondary: z.object({
    unanswered: z.number().int().nonnegative(),
    unansweredQuotes: z.number().int().nonnegative(),
    approvalRate: z.number().nullable(),
    churnRate: z.number().nullable(),
    ltv: z.number().nullable(),
    // The counts the two customer cards print beside their rates
    // ("7" and "18% dos 39 clientes com serviço"; "entre os 32 clientes com
    // serviço"). All three are null together with `churnRate` and `ltv`
    // when nobody had a service in the period.
    /** Customers whose return fell due inside the period with no newer service. */
    lapsedCustomers: z.number().int().nonnegative().nullable(),
    /** Customers with at least one dated service ever — the base of `churnRate`. */
    customersWithService: z.number().int().nonnegative().nullable(),
    /** Customers with a service inside the period — the divisor of `ltv`. */
    customersServedInPeriod: z.number().int().nonnegative().nullable(),
  }),
  funnel: reportFunnelSchema,
  originRows: z.array(reportOriginRowSchema).length(3),
});

/** Full reports API response for the requested period and filters. */
export const reportResultSchema = z.object({
  query: reportQuerySchema,
  buckets: z.array(reportBucketSchema),
  newConversationCount: z.number().int().nonnegative(),
  activeConversationCount: z.number().int().nonnegative(),
  firstResponse: firstResponseStatsSchema,
  coverage: reportCoverageSchema,
  unanswered: unansweredSchema,
  subsequentResponse: subsequentResponseStatsSchema,
  respondedRate: reportCoverageSchema,
  byTag: z.array(reportByTagRowSchema),
  byCampaign: z.array(reportByCampaignRowSchema),
  scheduled: reportScheduledCountsSchema,
  attribution: reportAttributionSchema,
  insights: reportInsightsSchema,
});

/** Empty insights used when a cut has no funnel/KPI extras to show. */
export function emptyReportInsights() {
  return {
    primary: {
      leads: { value: 0 },
      conversionRate: { value: null },
      revenue: { value: 0 },
      meanFirstResponseMs: { value: null },
    },
    secondary: {
      unanswered: 0,
      unansweredQuotes: 0,
      approvalRate: null,
      churnRate: null,
      ltv: null,
      lapsedCustomers: null,
      customersWithService: null,
      customersServedInPeriod: null,
    },
    funnel: { novosContatos: 0, emAtendimento: 0, orcamentoEnviado: 0, servicosFeitos: 0 },
    originRows: [
      { origin: "AD" as const, leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
      { origin: "ORGANIC" as const, leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
      { origin: "UNKNOWN" as const, leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
    ],
  };
}

/** How a conversation entered the CRM: paid ad, organic WhatsApp, or unknown. */
export type ConversationSourceType = z.infer<typeof conversationSourceTypeSchema>;

/** Time bucket width for volume charts in the reports response. */
export type ReportGranularity = z.infer<typeof reportGranularitySchema>;

/** Query string for `GET /reports`; `periodStart` must not be after `periodEnd`. */
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** One time bucket in the volume chart with new and active conversation counts. */
export type ReportBucket = z.infer<typeof reportBucketSchema>;

/** First-reply latency distribution in milliseconds; null stats mean no eligible conversations. */
export type FirstResponseStats = z.infer<typeof firstResponseStatsSchema>;

/** Subsequent-reply latency stats, including total inbound messages in the period. */
export type SubsequentResponseStats = z.infer<typeof subsequentResponseStatsSchema>;

/** Answered-vs-total pair used for coverage and responded-rate metrics. */
export type ReportCoverage = z.infer<typeof reportCoverageSchema>;

/** One conversation still awaiting a first outbound reply, with wait time in milliseconds. */
export type UnansweredItem = z.infer<typeof unansweredItemSchema>;

/** Unanswered queue summary; `items` is capped at 100 rows for the dashboard preview. */
export type Unanswered = z.infer<typeof unansweredSchema>;

/** Conversation count grouped by tag for the reports breakdown table. */
export type ReportByTagRow = z.infer<typeof reportByTagRowSchema>;

/** Conversation count grouped by Meta ad campaign hierarchy for the reports breakdown table. */
export type ReportByCampaignRow = z.infer<typeof reportByCampaignRowSchema>;

/** Scheduled-message outbox counts by terminal state for the reports period. */
export type ReportScheduledCounts = z.infer<typeof reportScheduledCountsSchema>;

/** Global attribution-rule snapshot stated on the report (window and version in use). */
export type ReportAttributionRule = z.infer<typeof reportAttributionRuleSchema>;

/** REP-12 converted/total pair broken down by conversation `sourceType`. */
export type ReportAttributionBySource = z.infer<typeof reportAttributionBySourceSchema>;

/** REP-11 scheduled-return count and REP-12 conversion of linked novas. */
export type ReportAttribution = z.infer<typeof reportAttributionSchema>;

/** Primary KPI value plus optional delta percent. */
export type ReportKpi = z.infer<typeof reportKpiSchema>;

/** The furthest funnel point a conversation has reached. */
export type ConversationPipelineStage = z.infer<typeof conversationPipelineStageSchema>;

/** Four nested funnel stage counts. */
export type ReportFunnel = z.infer<typeof reportFunnelSchema>;

/** One origin-table row. */
export type ReportOriginRow = z.infer<typeof reportOriginRowSchema>;

/** Funnel / KPI / origin expansion on the report result. */
export type ReportInsights = z.infer<typeof reportInsightsSchema>;

/** Full reports API response for the requested period and filters. */
export type ReportResult = z.infer<typeof reportResultSchema>;
