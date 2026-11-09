/**
 * Test design (testing-strategy)
 *
 * Setup: suggestDate pure helper. No HTTP, no insert.
 *
 * Oracle: optional-name-one-schedule-mvp scheduled-messages — exactly one
 *   matching active rule is used; zero or two-or-more matches → six months
 *   after performedAt in America/Sao_Paulo. Priority MUST NOT pick a winner.
 *
 * Axes
 *   A1 matching count — 0 / 1 / 2+
 *   A2 performedAt — 2026-01-15
 *   A3 kind vs criterionId — match / miss / inactive
 *   A4 intervalUnit — months / days
 *   A5 priority — different numbers still do not break a two-match tie
 *
 * Outputs
 *   O1 six_months 2026-07-15; O2 rule winner; O3 no side effects
 *
 * Sampled-cell
 *   empty rules 2026-01-15          | A1 0 A2 | O1 | 2026-07-16 or rule
 *   exactly one 1-month rule        | A1 1    | O2 | six months
 *   two matches different priority  | A1 2 A5 | O1 | higher-priority 1-month
 *   two matches same priority       | A1 2    | O1 | localeCompare winner
 *   inactive skipped                | A3 off  | O1 | treated as match
 *   criterionId miss                | A3 miss | O1 | used miss rule
 *   days unit (exactly one)         | A4 days | O2 | +6 months
 *
 * Decision / branch map (suggest-date.ts)
 *   matching.length !== 1           T 0 / 2+ / inactive / miss; F exactly-one its
 *   rule.active                     T winner it; F inactive it
 *   validFrom/validTo window        F empty (null window, every it above);
 *     T sampled below (was named not-sampled; closed in the
 *     align-shipped-ui-to-pdf-artboards retrofit)
 *   criterionId null                T generic match-all in 2-match its; F miss it
 *   intervalUnit days               T days it; F months exactly-one it
 *
 * Out of scope: HTTP (scheduled.route.test.ts); persist (prisma store);
 *   localeCompare as product oracle (removed).
 */
import { describe, expect, it } from "vitest";
import { suggestDate, type IntervalRuleInput } from "./http.return-due.js";

const performedAt = new Date("2026-01-15T03:00:00.000Z");

function saoPauloYmd(instant: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function rule(partial: Partial<IntervalRuleInput> & Pick<IntervalRuleInput, "id" | "priority">): IntervalRuleInput {
  return {
    version: 1,
    criterion: "service",
    criterionId: null,
    intervalAmount: 3,
    intervalUnit: "months",
    active: true,
    validFrom: null,
    validTo: null,
    ...partial,
  };
}

describe("suggestDate", () => {
  it("adds six São Paulo calendar months when no rule matches", () => {
    const result = suggestDate({ performedAt, kind: "troca", rules: [] });

    expect(result.suggestionSource).toBe("six_months");
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-07-15");
    expect(result.intervalRuleId).toBeNull();
  });

  it("uses the interval of the only matching rule", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [rule({ id: "one", priority: 1, intervalAmount: 1 })],
    });

    expect(result.suggestionSource).toBe("rule");
    expect(result.intervalRuleId).toBe("one");
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-02-15");
  });

  it("falls back to six months when two matching rules have different priorities", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [
        rule({ id: "low", priority: 1, intervalAmount: 3 }),
        rule({ id: "high", priority: 10, intervalAmount: 1 }),
      ],
    });

    expect(result.suggestionSource).toBe("six_months");
    expect(result.intervalRuleId).toBeNull();
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-07-15");
  });

  it("falls back to six months when two matching rules share a priority", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [
        rule({ id: "alpha", priority: 5, intervalAmount: 1 }),
        rule({ id: "beta", priority: 5, intervalAmount: 2 }),
      ],
    });

    expect(result.suggestionSource).toBe("six_months");
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-07-15");
  });

  it("skips an inactive rule and falls back to six months", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [rule({ id: "off", priority: 99, active: false, intervalAmount: 1 })],
    });

    expect(result.suggestionSource).toBe("six_months");
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-07-15");
  });

  it("does not match a rule whose criterionId differs from kind", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [rule({ id: "oil", priority: 5, criterionId: "oil" })],
    });

    expect(result.suggestionSource).toBe("six_months");
  });

  it("does not match a rule whose validFrom is after performedAt", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [
        rule({
          id: "future",
          priority: 1,
          intervalAmount: 1,
          validFrom: new Date("2026-02-01T00:00:00.000Z"),
        }),
      ],
    });

    expect(result.suggestionSource).toBe("six_months");
    expect(result.intervalRuleId).toBeNull();
  });

  it("does not match a rule whose validTo is before performedAt", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [
        rule({
          id: "expired",
          priority: 1,
          intervalAmount: 1,
          validTo: new Date("2025-12-01T00:00:00.000Z"),
        }),
      ],
    });

    expect(result.suggestionSource).toBe("six_months");
    expect(result.intervalRuleId).toBeNull();
  });

  it("adds days when the only matching rule uses the days unit", () => {
    const result = suggestDate({
      performedAt,
      kind: "troca",
      rules: [rule({ id: "week", priority: 1, intervalAmount: 10, intervalUnit: "days" })],
    });

    expect(result.suggestionSource).toBe("rule");
    expect(saoPauloYmd(result.suggestedAt)).toBe("2026-01-25");
  });
});
