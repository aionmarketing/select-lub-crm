/**
 * The inbox list's read: the loja's conversations, filtered, newest first, each
 * with its contact label, snippet, unanswered flag and derived pipeline stage.
 *
 * Moved from `list()` in `apps/api/src/conversations/prisma.ts` (4A), queries
 * unchanged. Each read runs in its own `db.tx("conversations", …)`; the three
 * that depend only on the listed ids run side by side. `customer`, `oil_quote`
 * and `service_conversation_attribution` are other modules' tables, read under
 * `module_conversations` (every table is `readableBy "*"`).
 */
import { conversationChatKeyFromJid, conversationListSnippet, hasPendingShouldReply, type ConversationMessage, type ConversationSummary } from "../contracts/http.js";
import { pipelineStageReached, type ConversationSourceType } from "../../reports/contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { summaryFrom, type ConversationListQuery } from "../internal/conversation-dto.js";

/**
 * Lists the loja's conversations for the inbox.
 *
 * @param db - The database handle.
 * @param unitId - The request's loja.
 * @param query - Already-narrowed filters; see {@link ConversationListQuery}.
 * @returns Summaries with empty `tags`; the route attaches the chips.
 */
export async function listConversations(
  db: Db,
  unitId: string,
  query: ConversationListQuery = {},
): Promise<ConversationSummary[]> {
  const rows = await db.tx("conversations", (tx) =>
    tx.conversation.findMany({
      // Origin and the period narrow in the database, since both are columns on
      // the conversation. The stage cannot: it is derived, so it filters after
      // the facts are read, below.
      where: {
        whatsappConnection: { unitId },
        ...(query.origin === undefined ? {} : { sourceType: query.origin }),
        ...(query.periodStart === undefined && query.periodEnd === undefined
          ? {}
          : {
              firstInboundAt: {
                ...(query.periodStart === undefined ? {} : { gte: query.periodStart }),
                ...(query.periodEnd === undefined ? {} : { lt: query.periodEnd }),
              },
            }),
      },
      orderBy: { lastMessageAt: "desc" },
      include: {
        messages: {
          select: { direction: true, messageType: true, textBody: true, providerTimestamp: true, shouldReply: true },
          orderBy: { providerTimestamp: "desc" },
        },
      },
    }),
  );
  const customerIds = [...new Set(rows.map((row) => row.customerId).filter((id): id is string => id != null))];
  const customers = customerIds.length
    ? await db.tx("conversations", (tx) =>
        tx.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } }),
      )
    : [];
  const nameById = new Map(customers.map((customer) => [customer.id, customer.name]));
  let filtered = rows;
  const q = query.q?.trim();
  if (q) {
    const digits = conversationChatKeyFromJid(q) ?? "";
    const qLower = q.toLowerCase();
    filtered = filtered.filter((row) => {
      const phoneMatch = digits !== "" && row.chatKey.includes(digits);
      const name = row.customerId ? nameById.get(row.customerId) : undefined;
      const nameMatch = name ? name.toLowerCase().includes(qLower) : false;
      return phoneMatch || nameMatch;
    });
  }
  if (query.unanswered) {
    filtered = filtered.filter((row) => hasPendingShouldReply(row.messages));
  }
  // Two set reads for the whole page, not one pair per row: the stage needs only
  // "does a quote name this conversation" and "does an attribution", so `select`
  // narrows both to the id column. Measured cost is recorded on task 8.3 of
  // `align-shipped-ui-to-revised-canvas`.
  const listedIds = filtered.map((row) => row.id);
  const [quoted, attributed] = listedIds.length
    ? await Promise.all([
        db.tx("conversations", (tx) =>
          tx.oilQuote.findMany({
            where: { conversationId: { in: listedIds } },
            select: { conversationId: true },
            distinct: ["conversationId"],
          }),
        ),
        db.tx("conversations", (tx) =>
          tx.serviceConversationAttribution.findMany({
            where: { conversationId: { in: listedIds } },
            select: { conversationId: true },
            distinct: ["conversationId"],
          }),
        ),
      ])
    : [[], []];
  const quotedIds = new Set(quoted.map((quote) => quote.conversationId).filter((id): id is string => id !== null));
  const attributedIds = new Set(attributed.map((row) => row.conversationId));

  const summaries = filtered.map((row) =>
    summaryFrom({
      id: row.id,
      phone: row.chatKey,
      lastSnippet: conversationListSnippet(
        (row.messages[0]?.messageType as ConversationMessage["messageType"]) ?? "text",
        row.messages[0]?.textBody ?? null,
      ),
      lastMessageAt: row.lastMessageAt,
      sourceType: row.sourceType as ConversationSourceType,
      unanswered: hasPendingShouldReply(row.messages),
      customerName: row.customerId ? (nameById.get(row.customerId) ?? null) : null,
      stageFacts: {
        // The messages are already loaded for the snippet and the unanswered
        // flag, so the reply fact costs no extra query.
        hasTeamReply: row.messages.some((message) => message.direction === "outbound"),
        hasQuoteSent: quotedIds.has(row.id),
        hasServiceAttributed: attributedIds.has(row.id),
      },
    }),
  );
  // Cumulative, not exact: the funnel counts a stage as "reached that point or
  // further" (`pipelineStageReached` over the ordinal stage list), so a reader
  // activating "ver as 30" on Orcamento Enviado must land on those 30 including
  // the ones that went on to Servicos Feitos. Exact equality returned only the
  // conversations whose FURTHEST point is this stage, which silently dropped the
  // later ones and made the destination smaller than the count that linked to it
  // (conversas spec, "Stage filter matches the funnel"). It reuses the funnel's
  // own helper rather than a second comparison so the two cannot drift apart.
  const stage = query.stage;
  return stage === undefined
    ? summaries
    : summaries.filter((summary) => pipelineStageReached(summary.pipelineStage, stage));
}
