/**
 * Test design (testing-strategy)
 *
 * Setup: import the origin constants. No database.
 *
 * Spec (demo-seed — "Every message has a seed or live origin"):
 *   Every Message row SHALL carry origin SEED or LIVE. A third spelling is not
 *   in the vocabulary the seed and ingest write.
 *
 * Partitions:
 *   P1 LIVE  — ingest/history stamp
 *   P2 SEED  — demo seed stamp
 *
 * Outputs: O1 the exported union is exactly those two strings
 *
 * Map: MESSAGE_ORIGINS is the closed catalog — P1 and P2.
 */
import { describe, expect, it } from "vitest";
import {
  MESSAGE_ORIGIN_LIVE,
  MESSAGE_ORIGIN_SEED,
  MESSAGE_ORIGINS,
  type MessageOrigin,
} from "./message-origin.js";

describe("message origin vocabulary", () => {
  it("exports only LIVE and SEED", () => {
    expect(MESSAGE_ORIGINS).toEqual([MESSAGE_ORIGIN_LIVE, MESSAGE_ORIGIN_SEED]);
    expect(MESSAGE_ORIGIN_LIVE).toBe("LIVE");
    expect(MESSAGE_ORIGIN_SEED).toBe("SEED");

    const live: MessageOrigin = MESSAGE_ORIGIN_LIVE;
    const seed: MessageOrigin = MESSAGE_ORIGIN_SEED;
    expect(live).not.toBe(seed);
  });
});
