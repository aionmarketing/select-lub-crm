/**
 * `GET /reports/conversations` — the Relatórios report for the caller's unit and
 * one period: conversation volume, response times, the funnel, the origin table,
 * the customer figures and the attribution counts.
 *
 * Reading it also writes: the attribution rows the cut is missing are inserted
 * on the way (`internal/recompute-attribution.ts`), after the reads, so the
 * counts returned include them.
 *
 * Moved from `apps/api/src/reports/{routes,prisma}.ts`. The route, its schema,
 * its 403 on an unscoped request and its body are unchanged.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../../kernel/db.js";
import type { SliceRoute } from "../../../kernel/http.js";
import { unitIdOf } from "../../../kernel/request.js";
import { reportQuerySchema, reportResultSchema, type ReportQuery, type ReportResult } from "../contracts/http.js";
import {
  countAttribution,
  currentAttributionRule,
  linkedNovas,
} from "../internal/attribution.js";
import { finishReport, previousPeriodQuery } from "../internal/insights.js";
import { recomputeAttribution } from "../internal/recompute-attribution.js";
import { loadReportFacts } from "./queries.js";

/** A sent quote, as the unanswered-quote count reads it. */
export type UnansweredQuoteInput = {
  quoteId: string;
  conversationId: string | null;
  unitId: string;
  createdAt: Date;
  label: string;
};

/** An inbound message, as the unanswered-quote count reads it. */
export type InboundMessageInput = { conversationId: string; providerTimestamp: Date };

/** What this slice needs from outside the module. */
export type ReportConversationsPorts = {
  /**
   * How many of the unit's sent quotes are still unanswered. The follow-up
   * rules own that answer; until follow-up is a module, `apps/api` supplies it
   * from its existing function.
   */
  unansweredQuotes(quotes: UnansweredQuoteInput[], inbounds: InboundMessageInput[], unitId: string): number;
};

async function summarize(
  db: Db,
  unitId: string,
  query: ReportQuery,
  ports: ReportConversationsPorts,
): Promise<ReportResult> {
  const facts = await loadReportFacts(db, unitId, query);
  const rule = currentAttributionRule(facts.ruleRow ? [facts.ruleRow] : []);
  const novas = linkedNovas(facts.rows, unitId, query);
  const pairs = await recomputeAttribution(db, {
    unitId,
    query,
    rule,
    services: facts.services,
    anchors: facts.anchors,
    novas,
    quotes: facts.quotes,
    stored: facts.stored,
  });
  const attribution = countAttribution(rule, facts.services, pairs.scheduled, pairs.conversation, novas, unitId, query);
  const previousQuery = previousPeriodQuery(query);
  const previousAttribution = countAttribution(
    rule,
    facts.services,
    pairs.scheduled,
    pairs.conversation,
    linkedNovas(facts.rows, unitId, previousQuery),
    unitId,
    previousQuery,
  );
  const inbounds = facts.rows.flatMap((row) =>
    row.messages
      .filter((message) => message.direction === "inbound")
      .map((message) => ({ conversationId: row.conversationId, providerTimestamp: message.providerTimestamp })),
  );

  return finishReport({
    rows: facts.rows,
    unitId,
    query,
    scheduled: facts.scheduled,
    attribution,
    previousAttribution,
    services: facts.services,
    quotes: facts.quotes,
    quoteAttributions: pairs.quote,
    conversationAttributions: pairs.conversation,
    unansweredQuotes: ports.unansweredQuotes(
      facts.quotes.map((quote) => ({
        quoteId: quote.quoteId,
        conversationId: quote.conversationId,
        unitId: quote.unitId,
        createdAt: quote.createdAt,
        label: "",
      })),
      inbounds,
      unitId,
    ),
    rules: facts.intervalRules,
  });
}

/**
 * Builds the report for one unit and one cut, inserting any attribution rows it
 * is missing. Every statement runs in its own short `db.tx("reports", …)`: the
 * reads together, then the inserts one at a time — the same shape as the old
 * adapter's autocommit statements, so no statement shares a transaction budget
 * with another.
 *
 * @param db - The database handle.
 * @param input.unitId - The unit the report is scoped to.
 * @param input.query - Period, granularity and the optional filters.
 * @param ports - See {@link ReportConversationsPorts}.
 * @returns The full report.
 */
export function reportConversations(
  db: Db,
  input: { unitId: string; query: ReportQuery },
  ports: ReportConversationsPorts,
): Promise<ReportResult> {
  return summarize(db, input.unitId, input.query, ports);
}

const emptyBody = z.object({});

/** The route's schema: Fastify validates the query and serialises the body through it. */
export const schema = {
  querystring: reportQuerySchema,
  response: { 200: reportResultSchema, 401: emptyBody, 403: emptyBody },
};

/**
 * The route, with its ports closed over. The module's `createHttpPlugin` and the
 * slice's tests both mount it through the kernel's `registerSlice`.
 *
 * @param ports - See {@link ReportConversationsPorts}.
 * @returns The slice route.
 */
export function reportConversationsRoute(ports: ReportConversationsPorts): SliceRoute<typeof schema> {
  return {
    method: "GET",
    path: "/reports/conversations",
    schema,
    handler: async (request: FastifyRequest<{ Querystring: ReportQuery }>, reply: FastifyReply) => {
      const unitId = unitIdOf(request);
      if (!unitId) {
        return reply.code(403).send({});
      }
      return reportConversations(request.server.db, { unitId, query: request.query }, ports);
    },
  };
}
