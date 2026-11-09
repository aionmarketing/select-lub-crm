/**
 * Test design (testing-strategy) — quote options carry the research state
 *
 * Setup: zod safeParse on `quoteOptionsResultSchema`. No HTTP, no DB.
 *
 * Oracle: background-oil-research `shared-types` delta, "Quote options carry the research state",
 *   one `it` per scenario, plus the fixture parse. The Veículo scenarios are in customers'
 *   `http.vehicle-oil-research.test.ts`; the filter-source scenarios in `http.filter-contracts.test.ts`.
 *
 * Cells (scenario | expected | the bug it would miss)
 *   researching, 1–3, position 0, search, no pause | parses, no cards    | a required card list
 *   range 3–3                                      | rejected             | max ≥ min accepted
 *   retrying with retryAt                          | parses               | a pause union too narrow
 *   budget with resumesAt                          | rejected             | the dropped budget reason kept
 *   reason "later"                                 | rejected             | an open reason string
 *   clarification, several, no engine             | parses               | options.min(2)
 *   clarification, mismatch, one engine           | parses               | options.min(2)
 *   incomplete identity without missingFields     | rejected             | the reason without its fields
 *   empty / no_capacity without consultedAt        | rejected             | the row's date optional
 *   reuse_prompt / refetch_failed                  | rejected             | a retired status kept
 *   options with refresh and newerAttempt          | rejected             | both notes at once
 */
import { describe, expect, it } from "vitest";
import { quoteOptionsWithFiltersFixture } from "./http.fixtures.js";
import { quoteOptionsResultSchema } from "./http.oil-quote.js";

const TIMING = {
  requestedAt: "2026-09-26T17:00:00.000Z",
  now: "2026-09-26T17:02:15.000Z",
  expectedMinutes: { min: 1, max: 3 },
  queuePosition: 0,
  path: "search",
  paused: null,
};

const parses = (payload: unknown) => quoteOptionsResultSchema.safeParse(payload).success;

describe("quote options carry the research state", () => {
  it("parses a researching result without cards", () => {
    const parsed = quoteOptionsResultSchema.parse({ status: "researching", ...TIMING });

    expect(parsed).toEqual({ status: "researching", ...TIMING });
    expect(parsed).not.toHaveProperty("options");
  });

  it("rejects a range whose upper bound is not above the lower", () => {
    expect(parses({ status: "researching", ...TIMING, expectedMinutes: { min: 3, max: 3 } })).toBe(false);
  });

  it("parses a retry pause", () => {
    expect(parses({ status: "researching", ...TIMING, paused: { reason: "retrying", retryAt: "2026-09-26T17:05:00.000Z" } })).toBe(true);
  });

  it("parses a stopped pause", () => {
    expect(parses({ status: "researching", ...TIMING, paused: { reason: "stopped" } })).toBe(true);
  });

  it("rejects a budget pause", () => {
    expect(parses({ status: "researching", ...TIMING, paused: { reason: "budget", resumesAt: "2026-09-27T03:00:00.000Z" } })).toBe(false);
  });

  it("rejects an unknown pause reason", () => {
    expect(parses({ status: "researching", ...TIMING, paused: { reason: "later" } })).toBe(false);
  });

  it("parses a clarification naming no engine", () => {
    expect(parses({ status: "needs_clarification", coverage: "several", options: [] })).toBe(true);
  });

  it("parses a clarification naming one engine", () => {
    expect(parses({ status: "needs_clarification", coverage: "mismatch", options: ["1.6"] })).toBe(true);
  });

  it("rejects an incomplete identity without its missing fields, and an empty list of them", () => {
    expect(parses({ status: "no_spec", reason: "incomplete_identity" })).toBe(false);
    expect(parses({ status: "no_spec", reason: "incomplete_identity", missingFields: [] })).toBe(false);
    expect(parses({ status: "no_spec", reason: "incomplete_identity", missingFields: ["make", "version"] })).toBe(true);
    expect(parses({ status: "no_spec", reason: "no_source" })).toBe(true);
    expect(parses({ status: "no_spec" })).toBe(false);
  });

  it.each(["empty", "no_capacity"])("rejects %s without the row's date", (status) => {
    const cards = status === "no_capacity" ? { options: quoteOptionsWithFiltersFixture.options, filters: quoteOptionsWithFiltersFixture.filters } : {};
    const row = { status, viscosityGrades: ["5W-30"], viscosity: "5W-30", classification: "", ...cards };

    expect(parses(row)).toBe(false);
    expect(parses({ ...row, consultedAt: "2026-09-20T12:00:00.000Z" })).toBe(true);
  });

  it.each(["reuse_prompt", "refetch_failed"])("rejects the retired status %s", (status) => {
    expect(parses({ status, consultedAt: "2026-09-20T12:00:00.000Z", motulConsultedAt: null, tecfilConsultedAt: null })).toBe(false);
  });

  it("rejects options carrying both refresh and a newer attempt, and parses each alone", () => {
    const refresh = { ...TIMING };
    const newerAttempt = { outcome: "no_spec", finishedAt: "2026-09-25T12:00:00.000Z" };

    expect(parses({ ...quoteOptionsWithFiltersFixture, refresh, newerAttempt })).toBe(false);
    expect(parses({ ...quoteOptionsWithFiltersFixture, refresh })).toBe(true);
    expect(parses({ ...quoteOptionsWithFiltersFixture, newerAttempt })).toBe(true);
  });

  it("parses the exported options fixture", () => {
    expect(parses(quoteOptionsWithFiltersFixture)).toBe(true);
  });
});
