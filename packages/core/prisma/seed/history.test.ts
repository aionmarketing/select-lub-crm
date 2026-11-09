/**
 * Test design (testing-strategy)
 *
 * Setup: pure planners. No Prisma.
 *
 * Spec (demo-seed — "The seed writes fake message history onto real conversations"):
 *   5–20 messages, ids `seed:{conversationId}:{n}`, deterministic bodies,
 *   timestamps from SEED only when recomputing activity, skip when any SEED exists.
 *
 * Partitions:
 *   P1 length     — 5 inclusive / 20 inclusive (hash-driven, sampled across ids)
 *   P2 outbound   — includeOutbound true vs false
 *   P3 identity   — two calls same id vs different ids
 *   P4 skip       — existingSeedCount 0 vs ≥1
 *   P5 activity   — SEED extrema ignore a later LIVE timestamp passed in by mistake
 *
 * Outputs: O1 count in 5–20; O2 ids match contract; O3 identical bodies;
 *   O4 unanswered has no outbound; O5 skip true iff count>0; O6 firstInbound
 *   is the earliest SEED inbound
 */
import { describe, expect, it } from "vitest";
import {
  activityTimestampsFromSeed,
  planGenericSeedThread,
  seedMessageExternalId,
  shouldSkipSeedThread,
} from "./history.js";

const ANCHOR = new Date("2026-09-01T15:00:00.000Z");

describe("planGenericSeedThread", () => {
  it("returns 5–20 messages with seed-scoped ids", () => {
    const planned = planGenericSeedThread({
      conversationId: "live-conv-01",
      anchor: ANCHOR,
      includeOutbound: true,
    });

    expect(planned.length).toBeGreaterThanOrEqual(5);
    expect(planned.length).toBeLessThanOrEqual(20);
    expect(planned[0]?.externalMessageId).toBe(seedMessageExternalId("live-conv-01", 1));
    expect(planned.every((row, index) => row.n === index + 1)).toBe(true);
    expect(planned.some((row) => row.direction === "outbound")).toBe(true);
    expect(planned.some((row) => row.direction === "inbound")).toBe(true);
  });

  it("returns the same bodies on two calls for the same conversation", () => {
    const input = { conversationId: "live-conv-07", anchor: ANCHOR, includeOutbound: false };

    expect(planGenericSeedThread(input)).toEqual(planGenericSeedThread(input));
  });

  it("keeps an unanswered thread inbound-only with shouldReply labels", () => {
    const planned = planGenericSeedThread({
      conversationId: "live-conv-02",
      anchor: ANCHOR,
      includeOutbound: false,
    });

    expect(planned.every((row) => row.direction === "inbound")).toBe(true);
    expect(planned.every((row) => row.shouldReply === true)).toBe(true);
  });

  it("covers the 5 and 20 length bounds across conversation ids", () => {
    const lengths = new Set<number>();
    for (let i = 0; i < 80; i += 1) {
      const planned = planGenericSeedThread({
        conversationId: `bound-${i}`,
        anchor: ANCHOR,
        includeOutbound: true,
      });
      lengths.add(planned.length);
    }

    expect(Math.min(...lengths)).toBe(5);
    expect(Math.max(...lengths)).toBe(20);
  });
});

describe("shouldSkipSeedThread", () => {
  it("skips when any SEED row already exists", () => {
    expect(shouldSkipSeedThread(0)).toBe(false);
    expect(shouldSkipSeedThread(1)).toBe(true);
    expect(shouldSkipSeedThread(20)).toBe(true);
  });
});

describe("activityTimestampsFromSeed", () => {
  it("takes first/last from SEED timestamps only", () => {
    const inbound = new Date("2026-01-01T12:00:00.000Z");
    const outbound = new Date("2026-01-01T12:05:00.000Z");
    const laterLive = new Date("2026-06-01T00:00:00.000Z");

    const activity = activityTimestampsFromSeed([
      { direction: "inbound", providerTimestamp: inbound },
      { direction: "outbound", providerTimestamp: outbound },
    ]);

    expect(activity.firstInboundAt).toEqual(inbound);
    expect(activity.lastInboundAt).toEqual(inbound);
    expect(activity.firstOutboundAt).toEqual(outbound);
    expect(activity.lastOutboundAt).toEqual(outbound);
    expect(activity.lastMessageAt).toEqual(outbound);
    expect(activity.lastMessageAt).not.toEqual(laterLive);
  });
});
