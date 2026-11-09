/**
 * Test design (testing-strategy)
 *
 * SUT: the estimate's arithmetic (`estimate.ts`): `timingsFrom`, `queueTermS`, `storedEstimate`
 *   and `expectedMinutes`. No database; the populations are read in
 *   `test/oil-research-store.live.test.ts`.
 *
 * Oracle: background-oil-research D14 and `oil-research` "The expected duration is estimated
 *   from observed runs" — its scenarios, one case each: the defaults under twenty runs; P25 70 s
 *   and P90 250 s give 1–5; two ahead at a P50 of 100 s add ⌈200/60⌉ = 4 minutes to both bounds
 *   (1–5 → 5–9); a row claimed 8 min after it was requested on a 9–13 estimate keeps 9–13; the
 *   wait entered a minute after the request on the manual defaults gives 2–7. The minutes
 *   formula's floors: X ≥ 1 and Y ≥ X + 1.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_RANGES, expectedMinutes, percentile, queueTermS, storedEstimate, timingsFrom } from "./estimate.js";

const minutes = (elapsedS: number, queueS: number, range = DEFAULT_RUN_RANGES.search) => expectedMinutes(storedEstimate(elapsedS, queueS, range));

describe("the run range", () => {
  it("gives the defaults under twenty runs", () => {
    const nineteen = Array<number>(19).fill(900);
    expect(timingsFrom("search", nineteen)).toEqual({ range: { lowerS: 60, upperS: 300 }, p50S: 60 });
    expect(timingsFrom("manual", nineteen)).toEqual({ range: { lowerS: 60, upperS: 360 }, p50S: 60 });
    expect(minutes(0, 0)).toEqual({ min: 1, max: 5 });
  });

  it("takes P25 to P90 from twenty runs or more: 70 s and 250 s give 1–5", () => {
    const durations = [60, 60, 60, 60, 60, 70, ...Array<number>(12).fill(100), 250, 300, 300];
    const timings = timingsFrom("search", durations);
    expect(timings).toEqual({ range: { lowerS: 70, upperS: 250 }, p50S: 100 });
    expect(minutes(0, 0, timings.range)).toEqual({ min: 1, max: 5 });
  });

  it("interpolates between ranks, as percentile_cont does", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5, 9);
  });
});

describe("the queue term", () => {
  it("adds ⌈k × P50 / 60 s⌉ whole minutes to both bounds: two ahead at 100 s turn 1–5 into 5–9", () => {
    expect(queueTermS(2, 100)).toBe(240);
    expect(minutes(0, queueTermS(2, 100))).toEqual({ min: 5, max: 9 });
  });

  it("adds nothing with nobody ahead", () => {
    expect(queueTermS(0, 100)).toBe(0);
  });
});

describe("the three stored moments", () => {
  it("keeps 9–13 for a row claimed 8 min after it was requested when the queue was right", () => {
    // Requested with four ahead at a P50 of 2 min: 8 minutes of queue.
    expect(minutes(0, queueTermS(4, 120))).toEqual({ min: 9, max: 13 });
    // Claimed 8 min later: (started_at − requested_at) + the run range, no queue term.
    expect(minutes(8 * 60, 0)).toEqual({ min: 9, max: 13 });
  });

  it("gives 2–7 on entering the wait one minute after the request, on the manual defaults", () => {
    expect(minutes(60, 0, DEFAULT_RUN_RANGES.manual)).toEqual({ min: 2, max: 7 });
  });

  it("never goes below one minute, and keeps the upper bound above the lower", () => {
    expect(minutes(0, 0, { lowerS: 5, upperS: 10 })).toEqual({ min: 1, max: 2 });
    expect(minutes(0, 0, { lowerS: 300, upperS: 300 })).toEqual({ min: 5, max: 6 });
  });
});
