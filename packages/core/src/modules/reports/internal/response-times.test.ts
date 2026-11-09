/**
 * Test design (testing-strategy)
 *
 * Setup: pure medianMs / p90Ms / firstResponseStats. No HTTP, no DB.
 *
 * Split from `apps/api/src/reports/aggregate.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Siblings:
 * calendar.test.ts, response-times.test.ts, build-report-novas.test.ts,
 * build-report-activity.test.ts. Pure: runs under no module role.
 *
 * Oracle: openspec/changes/relatorios-remainder-metrics design.md D2/D3 (even-n
 *   median = average of the two middles; p90 nearest-rank ceil(0.9*n)).
 *
 * Sampled-cell
 * | `it` | fails if |
 * | odd-n median / even-n median / empty median | wrong middle rule |
 * | p90 empty / n=3 nearest-rank | p90 not last of [100,200,300] |
 *
 * Decision map (response-times.ts)
 *   D5 median length===0 T: medianMs([]); F: odd/even n
 *   D6 length % 2 === 1 T: n=3; F: n=2
 *   D7 p90 length===0 T: p90Ms([]); F: n=3
 *   D8 firstResponseStats empty T: []; F: three durations
 */

import { describe, expect, it } from "vitest";
import { firstResponseStats, medianMs, p90Ms } from "./response-times.js";

describe("medianMs and p90Ms", () => {
  it("returns null median for an empty set", () => {
    expect(medianMs([])).toBeNull();
  });

  it("returns the middle value for an odd-length set", () => {
    expect(medianMs([100, 200, 300])).toBe(200);
  });

  it("averages the two middle values for an even-length set", () => {
    expect(medianMs([100, 200])).toBe(150);
  });

  it("returns null p90 for an empty set", () => {
    expect(p90Ms([])).toBeNull();
  });
});

describe("firstResponseStats", () => {
  it("uses the same three durations for mean median and p90", () => {
    const stats = firstResponseStats([100, 200, 300]);

    expect(stats.eligibleCount).toBe(3);
    expect(stats.meanMs).toBe(200);
    expect(stats.medianMs).toBe(200);
    expect(stats.p90Ms).toBe(300);
  });

  it("returns null times when eligible set is empty", () => {
    expect(firstResponseStats([])).toEqual({
      meanMs: null,
      medianMs: null,
      p90Ms: null,
      eligibleCount: 0,
    });
  });
});
