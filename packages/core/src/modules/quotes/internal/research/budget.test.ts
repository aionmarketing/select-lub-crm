/**
 * Test design (testing-strategy)
 *
 * SUT: the day arithmetic and the budget predicate (`budget.ts`), the retry schedules
 *   (`research-states.ts`) and D15's `stopped` (`runner-row.ts`). No database; the day's sum
 *   and the claim's budget gate run live in `test/oil-research-store.live.test.ts`.
 *
 * Oracle: background-oil-research D13 — the day is America/Sao_Paulo's (02:59:59Z is the
 *   previous local day, 03:00:00Z the new one; a pause ends at the next local midnight); a
 *   budget of 0 holds the backfill. D10's backoff (5 min, then 15 min) and D12's Tecfil backoff
 *   (15 min, 1 h, 6 h, then every 24 h). D15's `stopped`: no row, `no_key`, an unexpired provider
 *   pause, or a stale heartbeat with no live lease; never a budget pause.
 */
import { describe, expect, it } from "vitest";
import { budgetReached, nextSaoPauloMidnight, saoPauloDay, saoPauloDayBounds } from "./budget.js";
import { researchBackoffMs, tecfilBackoffMs } from "./research-states.js";
import { researchStopped, type RunnerStatus } from "./runner-row.js";
import { runnerCanSearch } from "../../contracts/oil-research-attention.js";
import { webSearchAvailable } from "../retrieval/search-availability.js";

// Orchestrator ruling, review of #188: a quote-open re-opens a "not searched" no-source only
// while the runner's fresh heartbeat says it can web-search; the worker derives that from its env.
describe("whether the runner can search", () => {
  const now = new Date("2026-09-26T15:00:00.000Z");
  const fresh: RunnerStatus = {
    lastSeenAt: new Date(now.getTime() - 60_000),
    keySet: true,
    searchAvailable: true,
    day: "2026-09-26",
    daySpendUsd: 0,
    budgetUsd: 1,
    pausedReason: null,
    pausedUntil: null,
    sweepWatermark: null,
  };

  it.each([
    ["no runner row", null, false],
    ["a fresh heartbeat that can search", fresh, true],
    ["a fresh heartbeat that cannot", { ...fresh, searchAvailable: false }, false],
    ["a stale heartbeat that could", { ...fresh, lastSeenAt: new Date(now.getTime() - 3 * 60_000 - 1) }, false],
  ] as const)("reads %s", (_label, status, can) => {
    expect(runnerCanSearch(status as RunnerStatus | null, now)).toBe(can);
  });

  it.each([
    [{ OPENAI_API_KEY: "k" }, true],
    [{ OPENAI_API_KEY: "k", WEB_SEARCH_ENABLED: "false" }, false],
    [{}, false],
  ])("derives it from %j", (env, available) => {
    expect(webSearchAvailable(env)).toBe(available);
  });
});

describe("the São Paulo day", () => {
  it("counts 02:59:59Z toward the previous local day and 03:00:00Z toward the new one", () => {
    expect(saoPauloDay(new Date("2026-09-26T02:59:59.000Z"))).toBe("2026-09-25");
    expect(saoPauloDay(new Date("2026-09-26T03:00:00.000Z"))).toBe("2026-09-26");
  });

  it("bounds the day from local midnight to the next", () => {
    expect(saoPauloDayBounds(new Date("2026-09-26T15:00:00.000Z"))).toEqual({
      day: "2026-09-26",
      start: new Date("2026-09-26T03:00:00.000Z"),
      end: new Date("2026-09-27T03:00:00.000Z"),
    });
  });

  it("ends a budget pause at the next local midnight", () => {
    expect(nextSaoPauloMidnight(new Date("2026-09-26T19:00:00.000Z"))).toEqual(new Date("2026-09-27T03:00:00.000Z"));
    expect(nextSaoPauloMidnight(new Date("2026-09-27T02:30:00.000Z"))).toEqual(new Date("2026-09-27T03:00:00.000Z"));
  });
});

describe("the budget", () => {
  it.each([
    [0.99, 1, false],
    [1, 1, true],
    [1.2, 1, true],
    [0, 0, true],
  ])("spend %s against a budget of %s holds the backfill: %s", (spend, budget, held) => {
    expect(budgetReached(spend, budget)).toBe(held);
  });
});

describe("the retry schedules", () => {
  it("backs a research outage off 5 min, then 15 min", () => {
    expect([1, 2, 3].map(researchBackoffMs)).toEqual([5 * 60_000, 15 * 60_000, 15 * 60_000]);
  });

  it("backs Tecfil off 15 min, 1 h, 6 h, then every 24 h", () => {
    expect([1, 2, 3, 4, 9].map(tecfilBackoffMs)).toEqual([15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 24 * 60 * 60_000]);
  });
});

describe("stopped", () => {
  const now = new Date("2026-09-26T15:00:00.000Z");
  const seen: RunnerStatus = {
    lastSeenAt: new Date(now.getTime() - 60_000),
    keySet: true,
    searchAvailable: true,
    day: "2026-09-26",
    daySpendUsd: 0,
    budgetUsd: 1,
    pausedReason: null,
    pausedUntil: null,
    sweepWatermark: null,
  };

  it.each([
    ["no runner row", null, false, true],
    ["a fresh heartbeat", seen, false, false],
    ["no key", { ...seen, keySet: false, pausedReason: "no_key" }, false, true],
    ["an unexpired provider pause", { ...seen, pausedReason: "provider", pausedUntil: new Date(now.getTime() + 60_000) }, false, true],
    ["a provider pause already over", { ...seen, pausedReason: "provider", pausedUntil: new Date(now.getTime() - 1) }, false, false],
    ["a budget pause", { ...seen, pausedReason: "budget", pausedUntil: new Date(now.getTime() + 60_000) }, false, false],
    ["a stale heartbeat with no live lease", { ...seen, lastSeenAt: new Date(now.getTime() - 3 * 60_000 - 1) }, false, true],
    ["a stale heartbeat while a run holds its lease", { ...seen, lastSeenAt: new Date(now.getTime() - 10 * 60_000) }, true, false],
  ] as const)("reads %s", (_label, status, liveLease, stopped) => {
    expect(researchStopped(status as RunnerStatus | null, liveLease, now)).toBe(stopped);
  });
});
