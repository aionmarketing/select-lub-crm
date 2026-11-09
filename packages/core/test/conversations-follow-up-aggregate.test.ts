/**
 * Test design (testing-strategy)
 *
 * Setup: buildFollowUp with a frozen clock and in-memory snapshot. No HTTP.
 *
 * Oracle: openspec/changes/follow-up-screen/specs/follow-up/spec.md
 *   + design D2/D3 — unit scoping; quote answered by any inbound with
 *   providerTimestamp > quote createdAt; two quotes collapse to the newer
 *   date; quotes without conversationId omitted; vencido/aproximando split
 *   (return date < today vs today..today+14d inclusive, vencido wins);
 *   já-agendada flags but does not hide; aguardando uses shouldReply:true
 *   and is cleared by a later outbound; unlabeled ignored; counts equal
 *   listed lengths after the 100 cap.
 *
 * Techniques: EP + BVA on calendar split (yesterday / today / today+13 /
 *   today+14 / today+15), decision coverage of membership predicates.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 unit membership — this unit / other unit
 * A2 quote answered — inbound after / inbound at send / inbound before / none
 * A3 quote collapse — one quote / two unanswered / missing conversationId
 * A4 return calendar — yesterday / today / +13d / +14d / +15d
 * A5 já-agendada — future SCHEDULED / past SCHEDULED / none
 * A6 aguardando — labeled pending / outbound after / unlabeled / false
 * A7 cap — 3 rows / 101 rows
 * A8 closed entry — none / closed on the listed anchor / closed on an older
 *    anchor (a newer quote arrived) / closed in the OTHER section for the same
 *    conversation
 * A9 view — open / closed. Crossed with A8, since the two views are one
 *    predicate read in opposite directions and the pair has to stay exact:
 *    an entry in neither view is one nobody can find.
 * A10 quote message derivation — outbound body equals the quote text / no body
 *    matches but an outbound follows the quote / neither
 *
 * Outputs: listed ids, returnDate, hasScheduledFollowUp, counts === lengths
 *
 * Decision map (buildFollowUp)
 *   D1 quote.unitId !== unitId || conversationId == null → skip
 *   D2 inbound.providerTimestamp > quote.createdAt → leave list
 *   D3 collapse keep max createdAt
 *   D4 returnKey < today → vencido; else returnKey <= today+14 → aproximando
 *   D5 SCHEDULED && scheduledAt >= now → flag
 *   D6 oldestPendingShouldReplyAt null → skip waiting
 *   D7 Boolean(closed) !== wantClosed → drop from this view. Both arms in both
 *      views, across the two sections
 *   D8 quoteMessageIdOf: exact body hit / miss then first outbound at-or-after /
 *      miss then nothing at all → null
 *
 * Out of scope: Prisma; HTTP 403 (follow-up.route.test.ts); UI.
 */

import { describe, expect, it } from "vitest";
import { FOLLOW_UP_LIST_CAP } from "../src/modules/conversations/contracts/http.js";
import { buildFollowUp, type FollowUpSnapshot } from "../src/modules/conversations/internal/follow-up-aggregate.js";
import type { FollowUpOpenReturnRow } from "../src/modules/conversations/internal/follow-up-returns.js";

const NOW = new Date("2026-08-31T18:00:00.000Z");
const UNIT = "unit-a";
const OTHER = "unit-b";

function emptySnapshot(partial: Partial<FollowUpSnapshot> = {}): FollowUpSnapshot {
  return {
    quotes: [],
    inbounds: [],
    outbounds: [],
    openReturns: [],
    conversations: [],
    closedEntries: [],
    ...partial,
  };
}

/** One OPEN return, defaulted so a case names only what it is about. */
function openReturn(over: Partial<FollowUpOpenReturnRow> & { returnId: string }) {
  return {
    vehicleId: `veh-${over.returnId}`,
    plate: null,
    model: null,
    customerId: "cust-a",
    customerName: "A",
    conversationId: null,
    sourceServiceId: `svc-${over.returnId}`,
    returnDate: "2026-09-02",
    plannedReminderCount: 0,
    nextReminderAt: null,
    ...over,
  };
}

/** One unanswered quote, defaulted so a case names only what it is about. */
function quote(over: { quoteId: string; conversationId: string; createdAt?: Date; text?: string }) {
  return {
    unitId: UNIT,
    createdAt: new Date("2026-08-20T12:00:00.000Z"),
    label: "A",
    ...over,
  };
}

/** One conversation holding a pending labeled inbound and no outbound after it. */
function waiting(over: { conversationId: string; pendingAt?: string }) {
  return {
    conversationId: over.conversationId,
    unitId: UNIT,
    label: "A",
    customerId: "cust-a",
    lastMessageAt: NOW,
    messages: [
      {
        direction: "inbound",
        providerTimestamp: new Date(over.pendingAt ?? "2026-08-27T10:00:00.000Z"),
        shouldReply: true,
      },
    ],
  };
}

/** One closed row, of the unansweredQuotes section unless told otherwise. */
function closed(over: {
  conversationId: string;
  anchor: string;
  section?: "unansweredQuotes" | "waitingReply";
}) {
  return {
    section: "unansweredQuotes" as const,
    closedAt: new Date("2026-08-30T09:00:00.000Z"),
    closedByUserId: "user-1",
    ...over,
  };
}

describe("buildFollowUp", () => {
  it("omits other-unit quotes and waiting conversations", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [
          {
            quoteId: "q-a",
            conversationId: "c-a",
            unitId: UNIT,
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            label: "A",
          },
          {
            quoteId: "q-b",
            conversationId: "c-b",
            unitId: OTHER,
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            label: "B",
          },
        ],
        conversations: [
          {
            conversationId: "c-a",
            unitId: UNIT,
            label: "A",
            customerId: "cust-a",
            lastMessageAt: NOW,
            messages: [
              { direction: "inbound", providerTimestamp: new Date("2026-08-27T10:00:00.000Z"), shouldReply: true },
            ],
          },
          {
            conversationId: "c-b",
            unitId: OTHER,
            label: "B",
            customerId: "cust-b",
            lastMessageAt: NOW,
            messages: [
              { direction: "inbound", providerTimestamp: new Date("2026-08-27T10:00:00.000Z"), shouldReply: true },
            ],
          },
        ],
      }),
      UNIT,
      NOW,
    );

    expect(result.unansweredQuotes.map((row) => row.conversationId)).toEqual(["c-a"]);
    expect(result.waitingReply.map((row) => row.conversationId)).toEqual(["c-a"]);
    // Returns are deliberately not asserted here. The aggregate no longer scopes
    // them — the loader's query filters on the return's source service unit, and
    // buildReturnSections never sees a unit id. Asserting it here would test a
    // filter this unit does not apply.
  });

  it("drops a quote after any inbound later than the quote send time", () => {
    const sent = new Date("2026-08-20T12:00:00.000Z");
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [
          { quoteId: "q1", conversationId: "c1", unitId: UNIT, createdAt: sent, label: "Roberto" },
        ],
        inbounds: [{ conversationId: "c1", providerTimestamp: new Date("2026-08-20T12:00:00.001Z") }],
      }),
      UNIT,
      NOW,
    );
    expect(result.unansweredQuotes).toEqual([]);
    expect(result.counts.unansweredQuotes).toBe(0);
  });

  it("keeps a quote when the only inbound is at the send instant", () => {
    const sent = new Date("2026-08-20T12:00:00.000Z");
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [
          { quoteId: "q1", conversationId: "c1", unitId: UNIT, createdAt: sent, label: "Roberto" },
        ],
        inbounds: [{ conversationId: "c1", providerTimestamp: sent }],
      }),
      UNIT,
      NOW,
    );
    expect(result.unansweredQuotes).toHaveLength(1);
  });

  it("collapses two unanswered quotes in one conversation to the newer date", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [
          {
            quoteId: "q-old",
            conversationId: "c1",
            unitId: UNIT,
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            label: "Roberto",
          },
          {
            quoteId: "q-new",
            conversationId: "c1",
            unitId: UNIT,
            createdAt: new Date("2026-08-25T12:00:00.000Z"),
            label: "Roberto",
          },
        ],
      }),
      UNIT,
      NOW,
    );
    expect(result.unansweredQuotes).toHaveLength(1);
    expect(result.unansweredQuotes[0]?.quoteId).toBe("q-new");
    expect(result.unansweredQuotes[0]?.quoteSentAt).toBe("2026-08-25T12:00:00.000Z");
    expect(result.counts.unansweredQuotes).toBe(1);
  });

  it("omits quotes with no conversationId", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [
          {
            quoteId: "q-orphan",
            conversationId: null,
            unitId: UNIT,
            createdAt: new Date("2026-08-20T12:00:00.000Z"),
            label: "Roberto",
          },
        ],
      }),
      UNIT,
      NOW,
    );
    expect(result.unansweredQuotes).toEqual([]);
  });

  it("hands the return sections today and the 14-day horizon it computed", () => {
    // One case, not five. Which section a return lands in, both boundaries and
    // the reminder summary are buildReturnSections' own tests now; what belongs
    // here is that the aggregate passes it the right day and the right rows.
    const result = buildFollowUp(
      emptySnapshot({
        openReturns: [
          openReturn({ returnId: "late", customerId: "c1", returnDate: "2026-09-01" }),
          openReturn({ returnId: "soon", customerId: "c2", returnDate: "2026-09-16" }),
          openReturn({ returnId: "beyond", customerId: "c3", returnDate: "2026-09-17" }),
        ],
      }),
      UNIT,
      new Date("2026-09-02T12:00:00.000Z"),
    );

    expect(result.overdueReturns).toHaveLength(1);
    expect(result.upcomingReturns.map((row) => row.vehicle.returnDate)).toEqual(["2026-09-16"]);
    expect(result.counts.overdueReturns).toBe(1);
    expect(result.counts.upcomingReturns).toBe(1);
  });

  it("clears aguardando when an outbound follows the pending inbound", () => {
    const inboundAt = new Date("2026-08-27T10:00:00.000Z");
    const result = buildFollowUp(
      emptySnapshot({
        conversations: [
          {
            conversationId: "c1",
            unitId: UNIT,
            label: "Juliana",
            customerId: "cust-1",
            lastMessageAt: NOW,
            messages: [
              { direction: "inbound", providerTimestamp: inboundAt, shouldReply: true },
              { direction: "outbound", providerTimestamp: new Date("2026-08-27T11:00:00.000Z") },
            ],
          },
        ],
      }),
      UNIT,
      NOW,
    );
    expect(result.waitingReply).toEqual([]);
  });

  it("ignores unlabeled inbounds in aguardando", () => {
    const result = buildFollowUp(
      emptySnapshot({
        conversations: [
          {
            conversationId: "c1",
            unitId: UNIT,
            label: "Juliana",
            customerId: "cust-1",
            lastMessageAt: NOW,
            messages: [{ direction: "inbound", providerTimestamp: new Date("2026-08-27T10:00:00.000Z") }],
          },
        ],
      }),
      UNIT,
      NOW,
    );
    expect(result.waitingReply).toEqual([]);
  });

  it("orders aguardando by the oldest pending inbound first", () => {
    const result = buildFollowUp(
      emptySnapshot({
        conversations: [
          {
            conversationId: "c-new",
            unitId: UNIT,
            label: "New",
            customerId: "cust-new",
            lastMessageAt: NOW,
            messages: [
              {
                direction: "inbound",
                providerTimestamp: new Date("2026-08-30T10:00:00.000Z"),
                shouldReply: true,
              },
            ],
          },
          {
            conversationId: "c-old",
            unitId: UNIT,
            label: "Old",
            customerId: "cust-old",
            lastMessageAt: NOW,
            messages: [
              {
                direction: "inbound",
                providerTimestamp: new Date("2026-08-27T10:00:00.000Z"),
                shouldReply: true,
              },
            ],
          },
        ],
      }),
      UNIT,
      NOW,
    );
    expect(result.waitingReply.map((row) => row.conversationId)).toEqual(["c-old", "c-new"]);
  });

  it("drops a closed quote entry from the queue and its count", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [quote({ quoteId: "q-1", conversationId: "c-1" })],
        closedEntries: [closed({ conversationId: "c-1", anchor: "q-1" })],
      }),
      UNIT,
      NOW,
    );

    expect(result.unansweredQuotes).toEqual([]);
    // The count is the list's own length, so suppression cannot land in one and
    // not the other.
    expect(result.counts.unansweredQuotes).toBe(0);
  });

  it("lists the closed quote entry in the closed view, with who closed it", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [quote({ quoteId: "q-1", conversationId: "c-1" })],
        closedEntries: [closed({ conversationId: "c-1", anchor: "q-1" })],
      }),
      UNIT,
      NOW,
      "closed",
    );

    expect(result.unansweredQuotes.map((row) => row.quoteId)).toEqual(["q-1"]);
    expect(result.unansweredQuotes[0]?.closed).toEqual({
      anchor: "q-1",
      at: "2026-08-30T09:00:00.000Z",
      byUserId: "user-1",
    });
  });

  it("brings the entry back on a newer quote, and shows it in neither view as the old one", () => {
    // The anchor IS the mechanism: the entry the section now lists is the newer
    // quote, which no closed row names.
    const snapshot = emptySnapshot({
      quotes: [
        quote({ quoteId: "q-1", conversationId: "c-1" }),
        quote({
          quoteId: "q-2",
          conversationId: "c-1",
          createdAt: new Date("2026-08-29T12:00:00.000Z"),
        }),
      ],
      closedEntries: [closed({ conversationId: "c-1", anchor: "q-1" })],
    });

    expect(buildFollowUp(snapshot, UNIT, NOW).unansweredQuotes.map((row) => row.quoteId)).toEqual([
      "q-2",
    ]);
    // The closed view is empty rather than still showing q-1: consecutive
    // quotes collapse to the newest, so q-1 is not an entry in either
    // direction any more.
    expect(buildFollowUp(snapshot, UNIT, NOW, "closed").unansweredQuotes).toEqual([]);
  });

  it("closes a quote entry without touching the same conversation's waiting entry", () => {
    const snapshot = emptySnapshot({
      quotes: [quote({ quoteId: "q-1", conversationId: "c-1" })],
      conversations: [waiting({ conversationId: "c-1" })],
      closedEntries: [closed({ conversationId: "c-1", anchor: "q-1" })],
    });
    const result = buildFollowUp(snapshot, UNIT, NOW);

    expect(result.unansweredQuotes).toEqual([]);
    // Same conversation, other section, still listed. Closing is scoped to the
    // entry, never to the customer or the conversation as a whole.
    expect(result.waitingReply.map((row) => row.conversationId)).toEqual(["c-1"]);
    expect(result.counts.waitingReply).toBe(1);
  });

  it("closes a waiting entry against its pending instant and reopens it on a newer one", () => {
    const pendingAt = "2026-08-27T10:00:00.000Z";
    const closedOnPending = closed({
      conversationId: "c-1",
      anchor: pendingAt,
      section: "waitingReply",
    });

    expect(
      buildFollowUp(
        emptySnapshot({
          conversations: [waiting({ conversationId: "c-1", pendingAt })],
          closedEntries: [closedOnPending],
        }),
        UNIT,
        NOW,
      ).waitingReply,
    ).toEqual([]);

    // A different pending inbound is a different anchor, so the same closed row
    // no longer matches and the entry is listed again.
    expect(
      buildFollowUp(
        emptySnapshot({
          conversations: [
            waiting({ conversationId: "c-1", pendingAt: "2026-08-28T10:00:00.000Z" }),
          ],
          closedEntries: [closedOnPending],
        }),
        UNIT,
        NOW,
      ).waitingReply.map((row) => row.conversationId),
    ).toEqual(["c-1"]);
  });

  it("points a quote entry at the outbound message carrying its text", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [quote({ quoteId: "q-1", conversationId: "c-1", text: "Segue o orcamento" })],
        outbounds: [
          {
            conversationId: "c-1",
            messageId: "m-earlier",
            textBody: "oi",
            providerTimestamp: new Date("2026-08-20T11:00:00.000Z"),
          },
          {
            conversationId: "c-1",
            messageId: "m-quote",
            textBody: "Segue o orcamento",
            providerTimestamp: new Date("2026-08-20T12:00:05.000Z"),
          },
        ],
      }),
      UNIT,
      NOW,
    );

    expect(result.unansweredQuotes[0]?.quoteMessageId).toBe("m-quote");
  });

  it("falls back to the first outbound at or after the quote when the text was edited", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [quote({ quoteId: "q-1", conversationId: "c-1", text: "Segue o orcamento" })],
        outbounds: [
          // Before the quote: not what it became, however similar it looks.
          {
            conversationId: "c-1",
            messageId: "m-before",
            textBody: "bom dia",
            providerTimestamp: new Date("2026-08-20T11:59:59.000Z"),
          },
          {
            conversationId: "c-1",
            messageId: "m-sent",
            textBody: "Segue o orcamento (com desconto)",
            providerTimestamp: new Date("2026-08-20T12:00:00.000Z"),
          },
        ],
      }),
      UNIT,
      NOW,
    );

    // BVA on the fallback boundary: it is at-or-after, so a message sent on the
    // quote's own instant is the one it became.
    expect(result.unansweredQuotes[0]?.quoteMessageId).toBe("m-sent");
  });

  it("reports no quote message rather than guessing when the thread has none after it", () => {
    const result = buildFollowUp(
      emptySnapshot({
        quotes: [quote({ quoteId: "q-1", conversationId: "c-1", text: "Segue o orcamento" })],
        outbounds: [
          {
            conversationId: "c-1",
            messageId: "m-before",
            textBody: "bom dia",
            providerTimestamp: new Date("2026-08-20T11:00:00.000Z"),
          },
          // Another thread entirely: never a candidate, whatever it says.
          {
            conversationId: "c-2",
            messageId: "m-other",
            textBody: "Segue o orcamento",
            providerTimestamp: new Date("2026-08-20T12:00:00.000Z"),
          },
        ],
      }),
      UNIT,
      NOW,
    );

    // Null, not a wrong bubble. The screen degrades to the thread's normal
    // position, which it already does for a message id it cannot find.
    expect(result.unansweredQuotes[0]?.quoteMessageId).toBeNull();
  });

  it("sets each count equal to the listed length after the cap", () => {
    const quotes = Array.from({ length: FOLLOW_UP_LIST_CAP + 1 }, (_, i) => ({
      quoteId: `q${i}`,
      conversationId: `c${i}`,
      unitId: UNIT,
      createdAt: new Date(Date.UTC(2026, 7, 1, 12, 0, i)),
      label: `Q${i}`,
    }));
    const result = buildFollowUp(emptySnapshot({ quotes }), UNIT, NOW);
    expect(result.unansweredQuotes).toHaveLength(FOLLOW_UP_LIST_CAP);
    expect(result.counts.unansweredQuotes).toBe(result.unansweredQuotes.length);
    expect(result.counts.overdueReturns).toBe(result.overdueReturns.length);
    expect(result.counts.upcomingReturns).toBe(result.upcomingReturns.length);
    expect(result.counts.waitingReply).toBe(result.waitingReply.length);
  });
});
