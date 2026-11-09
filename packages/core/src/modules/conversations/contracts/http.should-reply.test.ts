/**
 * Test design (testing-strategy)
 *
 * Setup: hasPendingShouldReply / oldestPendingShouldReplyAt. No HTTP.
 *
 * Oracle: should-reply-window conversas + relatorios deltas — unanswered
 * iff a shouldReply:true inbound has no later outbound; wait from the
 * oldest such inbound; unlabeled and false ignored.
 *
 * Axes
 *   A1 label — true / false / unlabeled
 *   A2 later outbound — absent / present after / present before
 *   A3 two true inbounds — both pending vs older cleared
 *
 * Outputs: O1 pending true; O2 pending false; O3 oldest timestamp
 *
 * Sampled-cell
 *   true no outbound              | A1 T A2 absent | O1 O3 | false
 *   true then outbound            | A2 after       | O2    | still pending
 *   false latest inbound          | A1 false       | O2    | pending
 *   unlabeled only                | A1 unlabeled   | O2    | pending
 *   two true, no outbound         | A3 both        | O3 older | newer timestamp
 *   outbound between two trues    | A3 older cleared | O3 newer | older
 *
 * Decision map
 *   D1 shouldReply !== true     T: false/unlabeled its; F: true its
 *   D2 later outbound exists    T: cleared it; F: pending its
 *   D3 loop continues to older  T: two-true oldest it; F: single true
 *
 * Out of scope: HTTP list serialization (conversations tests); LLM labeling.
 */
import { describe, expect, it } from "vitest";
import { hasPendingShouldReply, oldestPendingShouldReplyAt } from "./http.should-reply.js";

const t1 = new Date("2026-08-31T12:00:00.000Z");
const t2 = new Date("2026-08-31T12:01:00.000Z");
const t3 = new Date("2026-08-31T12:02:00.000Z");

describe("hasPendingShouldReply", () => {
  it("is unanswered when a true inbound has no later outbound", () => {
    expect(
      hasPendingShouldReply([
        { direction: "inbound", providerTimestamp: t1, shouldReply: true },
      ]),
    ).toBe(true);
  });

  it("is cleared when an outbound follows the true inbound", () => {
    expect(
      hasPendingShouldReply([
        { direction: "inbound", providerTimestamp: t1, shouldReply: true },
        { direction: "outbound", providerTimestamp: t2 },
      ]),
    ).toBe(false);
  });

  it("ignores a false latest inbound", () => {
    expect(
      hasPendingShouldReply([
        { direction: "inbound", providerTimestamp: t1, shouldReply: false },
      ]),
    ).toBe(false);
  });

  it("ignores unlabeled inbound history", () => {
    expect(
      hasPendingShouldReply([{ direction: "inbound", providerTimestamp: t1 }]),
    ).toBe(false);
  });
});

describe("oldestPendingShouldReplyAt", () => {
  it("returns the older of two pending true inbounds", () => {
    expect(
      oldestPendingShouldReplyAt([
        { direction: "inbound", providerTimestamp: t1, shouldReply: true },
        { direction: "inbound", providerTimestamp: t2, shouldReply: true },
      ]),
    ).toEqual(t1);
  });

  it("skips a true inbound that an outbound already followed", () => {
    expect(
      oldestPendingShouldReplyAt([
        { direction: "inbound", providerTimestamp: t1, shouldReply: true },
        { direction: "outbound", providerTimestamp: t2 },
        { direction: "inbound", providerTimestamp: t3, shouldReply: true },
      ]),
    ).toEqual(t3);
  });
});
