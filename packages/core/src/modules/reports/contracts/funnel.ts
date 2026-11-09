/**
 * The REP-15 funnel, published: how many conversations of a period reached each
 * pipeline stage.
 *
 * It is a contract rather than an internal because another module has to agree
 * with it. Conversations shows each thread's stage from the same rule
 * (`conversationPipelineStage`), and `apps/api/src/conversations.pipeline-stage.test.ts`
 * holds the two to the same numbers. Reports' own insights call `reportFunnel`
 * for the funnel they draw, so the rule that test pins is the one the screen
 * uses.
 *
 * Moved out of `buildPeriodInsights` (`apps/api/src/reports/insights.ts`) when
 * the reports module was created, with its logic unchanged.
 */
import { conversationPipelineStage, pipelineStageReached, type ConversationPipelineStage, type ReportInsights } from "./http.reports.js";

/** What the funnel reads of a conversation. Structural: a report row satisfies it. */
export type FunnelConversation = {
  conversationId: string;
  unitId: string;
  firstInboundAt: Date | null;
  firstOutboundAt: Date | null;
};

/** What the funnel reads of a sent quote. */
export type FunnelQuote = { unitId: string; conversationId: string | null };

/** What the funnel reads of a conversation's service attribution (REP-12). */
export type FunnelAttribution = { conversationId: string };

/** The four funnel counts, each cumulative: a stage counts everything that reached it or further. */
export type ReportFunnel = ReportInsights["funnel"];

/**
 * Whether a conversation is a nova of the period: in the unit, with its first
 * inbound inside `[periodStart, periodEnd)`. The funnel's first stage, and the
 * population every other stage is drawn from.
 *
 * @param row - The conversation.
 * @param unitId - The unit the report is scoped to.
 * @param periodStart - Inclusive start.
 * @param periodEnd - Exclusive end.
 * @returns True when the conversation is one of the period's new contacts.
 */
export function isNovaInPeriod(
  row: FunnelConversation,
  unitId: string,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  if (row.unitId !== unitId || !row.firstInboundAt) {
    return false;
  }
  const at = row.firstInboundAt.getTime();
  return at >= periodStart.getTime() && at < periodEnd.getTime();
}

/**
 * Counts the period's novas at each funnel stage.
 *
 * @param input.rows - Conversations; only the unit's novas of the period count.
 * @param input.unitId - The unit the report is scoped to.
 * @param input.periodStart - Inclusive start.
 * @param input.periodEnd - Exclusive end.
 * @param input.quotes - Sent quotes; one naming a conversation of the unit marks it quoted.
 * @param input.conversationAttributions - REP-12 pairs; one naming a nova marks it served.
 * @returns The four cumulative counts.
 */
export function reportFunnel(input: {
  rows: readonly FunnelConversation[];
  unitId: string;
  periodStart: Date;
  periodEnd: Date;
  quotes: readonly FunnelQuote[];
  conversationAttributions: readonly FunnelAttribution[];
}): ReportFunnel {
  const novas = input.rows.filter((row) =>
    isNovaInPeriod(row, input.unitId, input.periodStart, input.periodEnd),
  );
  const novaIds = new Set(novas.map((row) => row.conversationId));
  const quotedConversations = new Set(
    input.quotes
      .filter((quote) => quote.unitId === input.unitId && quote.conversationId != null)
      .map((quote) => quote.conversationId as string),
  );
  const convertedIds = new Set(
    input.conversationAttributions
      .filter((row) => novaIds.has(row.conversationId))
      .map((row) => row.conversationId),
  );

  // One rule, two readers: these counts and the conversation read shape both
  // take their stage from `conversationPipelineStage`, so a stage shown on a
  // thread and a stage counted here cannot come apart.
  const stages = novas.map((row) =>
    conversationPipelineStage({
      hasTeamReply: row.firstOutboundAt != null,
      hasQuoteSent: quotedConversations.has(row.conversationId),
      hasServiceAttributed: convertedIds.has(row.conversationId),
    }),
  );
  // A funnel count is cumulative: `emAtendimento` counts everything that
  // reached that point or further, which is what nesting each filter inside
  // the previous one used to express.
  const reached = (floor: ConversationPipelineStage) =>
    stages.filter((stage) => pipelineStageReached(stage, floor)).length;

  return {
    novosContatos: novas.length,
    emAtendimento: reached("emAtendimento"),
    orcamentoEnviado: reached("orcamentoEnviado"),
    servicosFeitos: reached("servicosFeitos"),
  };
}
