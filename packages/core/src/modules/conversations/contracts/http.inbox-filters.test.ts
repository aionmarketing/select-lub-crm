/**
 * Test design (testing-strategy)
 *
 * Added (align-shipped-ui-to-pdf-artboards retrofit). Coverage-first: this
 * package's own suite exercised zero of conversationListPeriod,
 * withinInboxPeriod and conversationListUnanswered before this file — all
 * three are pure and exported, but every existing sample of their behaviour
 * lived downstream in apps/api's conversations.filters.route.test.ts, which
 * (deliberately, per its own header) never queries `from` or `to` alone —
 * every period sample there gives both bounds together. That left one
 * decision genuinely unreached anywhere in the repo: withinInboxPeriod's
 * `end === undefined || firstInboundAt < end` can only reach the left
 * operand as true when `start` is defined and `end` is not (a from-only
 * period) — every existing "no period" sample has BOTH undefined, which
 * short-circuits one `if` earlier and never reaches that line at all.
 * Symmetric for a to-only period against the `start !== undefined && ...`
 * check.
 *
 * conversationListStage and conversationListOrigin are not resampled here:
 * apps/api's route test already exercises both outcomes of each (its own
 * decision map names them), and duplicating that would not reduce risk.
 *
 * Setup: pure functions, no HTTP, no zod parse.
 *
 * Oracle: withinInboxPeriod's and conversationListPeriod's own JSDoc ("end —
 * … or undefined for no bound", "to — … or undefined for no upper bound"),
 * and openspec/specs/conversations/conversas/spec.md "Inbox can be filtered by origin,
 * pipeline stage and period" ("an optional inclusive period").
 *
 * Axes
 *   A1 conversationListPeriod bounds — both / from only / to only / neither
 *   A2 withinInboxPeriod bound shape — unbounded both / from-only (before,
 *     at start, arbitrarily after) / to-only (before end, at end) / null
 *     firstInboundAt with a bound
 *   A3 conversationListUnanswered — "true" / "false" / omitted
 *
 * Decision map
 *   conversationListPeriod `from === undefined`            T neither/to-only; F from-only/both
 *   conversationListPeriod `to !== undefined`               T to-only/both; F neither/from-only
 *   withinInboxPeriod `start === undefined && end === undefined`  T neither it; F every bounded it
 *   withinInboxPeriod `firstInboundAt === null`             T null-firstInbound it; F every dated it
 *   withinInboxPeriod `start !== undefined && firstInboundAt < start`
 *     T before-start its; F at-start/to-only/unbounded its
 *   withinInboxPeriod `end === undefined || firstInboundAt < end`
 *     left T — from-only its (previously unreached); left F — to-only/both its
 *     right T — before-end it; right F — at-end it
 *   conversationListUnanswered `=== "true"`                 T "true" it; F "false"/omitted its
 */
import { describe, expect, it } from "vitest";
import { conversationListPeriod, conversationListUnanswered, withinInboxPeriod } from "./http.conversation.js";

describe("conversationListPeriod", () => {
  it("sets only a lower bound from a from-only query", () => {
    const { start, end } = conversationListPeriod("2026-08-10", undefined);
    expect(start).toEqual(new Date("2026-08-10T00:00:00.000-03:00"));
    expect(end).toBeUndefined();
  });

  it("sets only an upper bound from a to-only query", () => {
    const { start, end } = conversationListPeriod(undefined, "2026-08-10");
    expect(start).toBeUndefined();
    // Exclusive end is midnight of the day AFTER `to`, same rule as the
    // both-bounds case, so the last day is included in full.
    expect(end).toEqual(new Date("2026-08-11T00:00:00.000-03:00"));
  });

  it("sets neither bound when both are omitted", () => {
    expect(conversationListPeriod(undefined, undefined)).toEqual({
      start: undefined,
      end: undefined,
    });
  });
});

describe("withinInboxPeriod", () => {
  const from = new Date("2026-08-01T00:00:00.000-03:00");
  const to = new Date("2026-08-10T00:00:00.000-03:00");

  it("includes a firstInboundAt at or arbitrarily after a from-only start", () => {
    expect(withinInboxPeriod(from, from, undefined)).toBe(true);
    expect(withinInboxPeriod(new Date("2099-01-01T00:00:00.000-03:00"), from, undefined)).toBe(
      true,
    );
  });

  it("excludes a firstInboundAt before a from-only start", () => {
    expect(
      withinInboxPeriod(new Date("2026-07-31T23:59:59.000-03:00"), from, undefined),
    ).toBe(false);
  });

  it("includes a firstInboundAt before a to-only end", () => {
    expect(
      withinInboxPeriod(new Date("2020-01-01T00:00:00.000-03:00"), undefined, to),
    ).toBe(true);
  });

  it("excludes a firstInboundAt at or after a to-only end", () => {
    expect(withinInboxPeriod(to, undefined, to)).toBe(false);
  });

  it("excludes a null firstInboundAt from a from-only period", () => {
    expect(withinInboxPeriod(null, from, undefined)).toBe(false);
  });
});

describe("conversationListUnanswered", () => {
  it.each([
    ["true", true],
    ["false", false],
    [undefined, false],
  ] as const)("unanswered=%s -> %s", (value, expected) => {
    expect(conversationListUnanswered({ unanswered: value })).toBe(expected);
  });
});
