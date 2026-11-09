/**
 * Pure Follow-up aggregation: four section lists plus counts that match listed lengths.
 *
 * The same function builds the queue and its closed-entries view. Which one you
 * get is the `view` argument, because "closed" is the exact complement of
 * "open" — one predicate, read in one direction or the other. Two functions
 * would be two predicates, and the day they disagree an entry is in neither
 * view and nobody can find it.
 *
 * Moved from `apps/api/src/follow-up/aggregate.ts` (4A), unchanged.
 * `unansweredQuoteCount` is the reports module's `unansweredQuotes` port, handed
 * to it by the api's composition root through this module's index.
 */
import { FOLLOW_UP_LIST_CAP, oldestPendingShouldReplyAt, type FollowUpClosed, type FollowUpResult } from "../contracts/http.js";
import { followUpReturnWindow } from "../../services/contracts/index.js";
import { buildReturnSections, type FollowUpOpenReturnRow } from "./follow-up-returns.js";

/** Oil-quote row used to decide unanswered-quote membership. */
export type FollowUpQuoteRow = {
  quoteId: string;
  conversationId: string | null;
  unitId: string;
  createdAt: Date;
  label: string;
  /**
   * The message text the quote generated, used to find that message in the
   * thread. Optional because the Relatórios counter feeds this same row type
   * and never needs the link.
   */
  text?: string;
};

/** Inbound message used as the quote-answered predicate. */
export type FollowUpInboundRow = {
  conversationId: string;
  providerTimestamp: Date;
};

/**
 * Outbound thread message, used to point an entry at what it is about.
 *
 * Neither `OilQuote` nor `ScheduledMessage` has a foreign key to `Message` —
 * both are written before the message exists — so the link is derived by
 * matching text and time rather than read off a join.
 */
export type FollowUpOutboundRow = {
  conversationId: string;
  messageId: string;
  textBody: string | null;
  providerTimestamp: Date;
};

/** Conversation plus thread messages for the aguardando section and return links. */
export type FollowUpConversationRow = {
  conversationId: string;
  unitId: string;
  label: string;
  customerId: string | null;
  lastMessageAt: Date;
  messages: {
    direction: string;
    providerTimestamp: Date;
    shouldReply?: boolean | null;
  }[];
};

/** One closed message-pendency entry, as stored against the anchor that qualified it. */
export type FollowUpClosedRow = {
  section: "unansweredQuotes" | "waitingReply";
  conversationId: string;
  anchor: string;
  closedAt: Date;
  closedByUserId: string;
};

/** In-memory snapshot both adapters feed into {@link buildFollowUp}. */
export type FollowUpSnapshot = {
  quotes: FollowUpQuoteRow[];
  inbounds: FollowUpInboundRow[];
  outbounds: FollowUpOutboundRow[];
  /**
   * Vehicle returns for the unit, already joined to what a row renders.
   *
   * Replaces the services-plus-interval-rules pair this used to carry. Both
   * sections now read the STORED return date rather than recomputing it from
   * the latest service: recomputing is what made an edited date impossible, and
   * it is also what hid a car parked for months behind a sibling car serviced
   * last week, because the old rule looked at the customer's latest service
   * rather than each vehicle's own.
   *
   * The caller loads OPEN returns for the queue and ARCHIVED ones for the
   * closed view; this file never filters by status, so a row that should not be
   * listed was never loaded.
   */
  openReturns: FollowUpOpenReturnRow[];
  conversations: FollowUpConversationRow[];
  /** Closed rows for the two message-pendency sections, whichever view is built. */
  closedEntries: FollowUpClosedRow[];
};

/**
 * Which side of the suppression filter to return.
 *
 * `"open"` is the queue: entries that qualify and are not closed. `"closed"` is
 * its complement — entries that qualify and ARE closed, which is what makes a
 * suppressed queue visible rather than merely absent.
 */
export type FollowUpView = "open" | "closed";

function cap<T>(rows: T[]) {
  return rows.slice(0, FOLLOW_UP_LIST_CAP);
}

/**
 * The thread message an unanswered quote is about.
 *
 * `OilQuote` carries no message id: the quote row is written when the text is
 * composed, and the message only exists once the outbox has sent it. So the
 * link is derived — the outbound whose body IS the quote text, and failing
 * that the first outbound from the moment the quote was created, which is the
 * message that quote became when the attendant edited it before sending.
 *
 * @param quote - The quote to locate.
 * @param outbounds - Outbound messages of every conversation in scope.
 * @returns The message id, or null when the conversation holds no outbound at
 *   or after the quote — a thread the quote never reached. Null is a link to
 *   the conversation's normal position, not a broken link.
 */
export function quoteMessageIdOf(
  quote: FollowUpQuoteRow,
  outbounds: FollowUpOutboundRow[],
): string | null {
  const inThread = outbounds
    .filter((row) => row.conversationId === quote.conversationId)
    .sort((a, b) => a.providerTimestamp.getTime() - b.providerTimestamp.getTime());
  const exact = quote.text
    ? inThread.find((row) => row.textBody === quote.text)
    : undefined;
  if (exact) {
    return exact.messageId;
  }
  // No exact body: the attendant edited the text before sending, or the quote
  // went out as media. The first outbound from the quote's instant onwards is
  // the one it turned into.
  const after = inThread.find((row) => row.providerTimestamp >= quote.createdAt);
  return after?.messageId ?? null;
}

/** The closed row matching one entry, or undefined when the entry is live. */
function closedMatch(
  closedEntries: FollowUpClosedRow[],
  section: FollowUpClosedRow["section"],
  conversationId: string,
  anchor: string,
) {
  return closedEntries.find(
    (row) =>
      row.section === section && row.conversationId === conversationId && row.anchor === anchor,
  );
}

function asClosed(row: FollowUpClosedRow): FollowUpClosed {
  return { anchor: row.anchor, at: row.closedAt.toISOString(), byUserId: row.closedByUserId };
}

/**
 * Per-conversation unanswered-quote count (same collapse and cap as Follow-up).
 *
 * @param quotes - Oil quotes already scoped by the caller.
 * @param inbounds - Inbound messages used as the answered predicate.
 * @param unitId - Loja whose quotes are counted.
 * @returns Capped conversation count (max {@link FOLLOW_UP_LIST_CAP}).
 */
export function unansweredQuoteCount(
  quotes: FollowUpQuoteRow[],
  inbounds: FollowUpInboundRow[],
  unitId: string,
) {
  return buildFollowUp(
    {
      quotes,
      inbounds,
      outbounds: [],
      openReturns: [],
      conversations: [],
      closedEntries: [],
    },
    unitId,
    new Date(),
    // The list, not the count. Counts are optional on the contract because the
    // transport can report "not known" when the lists fail to load — but this
    // helper just built the list, so its length is the count, definitely.
  ).unansweredQuotes.length;
}

/**
 * Builds the Follow-up payload for one unit. Counts equal listed lengths after the cap.
 *
 * @param snapshot - Quotes, inbounds, outbounds, returns, conversations and the closed set.
 * @param unitId - Loja whose rows are included; other-unit rows are ignored.
 * @param now - Clock used for the calendar today and the +14 horizon.
 * @param view - `"open"` for the queue, `"closed"` for the entries closed out
 *   of it. Defaults to the queue.
 * @returns Four capped lists plus matching counts.
 */
export function buildFollowUp(
  snapshot: FollowUpSnapshot,
  unitId: string,
  now: Date,
  view: FollowUpView = "open",
): FollowUpResult {
  const wantClosed = view === "closed";

  const unansweredByConversation = new Map<string, FollowUpQuoteRow>();
  for (const quote of snapshot.quotes) {
    if (quote.unitId !== unitId || quote.conversationId == null) {
      continue;
    }
    const answered = snapshot.inbounds.some(
      (inbound) =>
        inbound.conversationId === quote.conversationId && inbound.providerTimestamp > quote.createdAt,
    );
    if (answered) {
      continue;
    }
    const previous = unansweredByConversation.get(quote.conversationId);
    if (!previous || quote.createdAt > previous.createdAt) {
      unansweredByConversation.set(quote.conversationId, quote);
    }
  }
  const unansweredQuotes = cap(
    // Oldest first. This reverses a deliberate newest-first sort: the section is
    // a work queue, and the quote that has gone unanswered longest is the one at
    // risk, so it belongs at the top rather than the bottom.
    [...unansweredByConversation.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((quote) => {
        // The quote id IS the anchor. A newer quote in the same conversation is
        // a different id, so an older close stops matching and the entry comes
        // back on its own — no expiry column and no sweep.
        const closed = closedMatch(
          snapshot.closedEntries,
          "unansweredQuotes",
          quote.conversationId as string,
          quote.quoteId,
        );
        if (Boolean(closed) !== wantClosed) {
          return null;
        }
        return {
          conversationId: quote.conversationId as string,
          quoteId: quote.quoteId,
          quoteSentAt: quote.createdAt.toISOString(),
          label: quote.label,
          quoteMessageId: quoteMessageIdOf(quote, snapshot.outbounds),
          ...(closed ? { closed: asClosed(closed) } : {}),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null),
  );

  const { today, horizon } = followUpReturnWindow(now);
  const { overdue: overdueReturns, upcoming: upcomingReturns } = buildReturnSections(
    snapshot.openReturns,
    today,
    horizon,
    FOLLOW_UP_LIST_CAP,
  );

  const waitingReply = cap(
    snapshot.conversations
      .filter((conversation) => conversation.unitId === unitId)
      .map((conversation) => {
        const oldestPendingAt = oldestPendingShouldReplyAt(conversation.messages);
        if (!oldestPendingAt) {
          return null;
        }
        // The pending instant is the anchor: a newer inbound after this one was
        // answered puts a different instant on the entry, which the old close
        // no longer matches.
        const closed = closedMatch(
          snapshot.closedEntries,
          "waitingReply",
          conversation.conversationId,
          oldestPendingAt.toISOString(),
        );
        if (Boolean(closed) !== wantClosed) {
          return null;
        }
        return {
          conversationId: conversation.conversationId,
          oldestPendingAt: oldestPendingAt.toISOString(),
          label: conversation.label,
          ...(closed ? { closed: asClosed(closed) } : {}),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
      .sort((a, b) => a.oldestPendingAt.localeCompare(b.oldestPendingAt)),
  );

  return {
    counts: {
      unansweredQuotes: unansweredQuotes.length,
      overdueReturns: overdueReturns.length,
      upcomingReturns: upcomingReturns.length,
      waitingReply: waitingReply.length,
    },
    unansweredQuotes,
    overdueReturns,
    upcomingReturns,
    waitingReply,
  };
}
