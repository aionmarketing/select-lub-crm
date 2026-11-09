/**
 * Test design (testing-strategy)
 *
 * SUT: `novaFirstInboundAt` — where the fixture seed places each seeded
 *   conversation's first inbound, as a function of the run's `now`. Pure; no
 *   Postgres, no Playwright.
 *
 * Oracle: openspec/specs/reports/relatorios/spec.md — "Granularity day week month
 *   without double-count": the scenario needs novas on DIFFERENT São Paulo days
 *   inside the period, so that day buckets outnumber month buckets while the
 *   total stays put. The Relatórios Colecionador tour walks exactly that
 *   scenario on the screen's default period (the last seven days), so the
 *   fixture has to hold that shape on every day the suite runs, not just on the
 *   day a database was first seeded.
 *
 * Axes
 *   A1 the instant the suite runs — swept hourly across a year, so month ends
 *      and the days around them are all visited
 *
 * Outputs
 *   O1 the novas fall on at least three distinct São Paulo days
 *   O2 every one of those days is inside the default seven-day window
 *   O3 grouped by month they make strictly fewer buckets than grouped by day,
 *      which is what lets the tour tell a reaggregation from a re-render
 *
 * Out of scope: the report's own bucketing (`packages/core` reports tests) and
 *   whether the seed writes the values (it upserts them on update too, which is
 *   what a database seeded days ago needs; that is the seed's control flow).
 */
import { describe, expect, it } from "vitest";
import { E2E } from "./ids.js";
import { novaFirstInboundAt } from "./seed-novas.js";

const SAO_PAULO = "America/Sao_Paulo";

/** The seeded conversations the report counts as novas: one at day 0 and every one that is spread. */
const CONVERSATIONS = [
  E2E.namelessConversationId,
  E2E.prefillAcceptConversationId,
  E2E.prefillDismissConversationId,
];

/** `YYYY-MM-DD` of an instant on the São Paulo calendar. */
function saoPauloDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

describe("the seeded novas keep the shape the granularity tour needs", () => {
  const hoursInAYear = 24 * 366;
  const start = Date.parse("2026-01-01T00:00:00Z");

  it("spreads over three São Paulo days, inside the default window, whenever the suite runs", () => {
    for (let hour = 0; hour < hoursInAYear; hour += 1) {
      const now = new Date(start + hour * 3_600_000);
      const days = new Set(CONVERSATIONS.map((id) => saoPauloDay(novaFirstInboundAt(now, id))));
      const months = new Set([...days].map((day) => day.slice(0, 7)));

      expect(days.size, `distinct days at ${now.toISOString()}`).toBeGreaterThanOrEqual(3);
      expect(months.size, `months at ${now.toISOString()}`).toBeLessThan(days.size);

      // The screen opens on the last seven São Paulo days, today included.
      const today = Date.parse(`${saoPauloDay(now)}T00:00:00Z`);
      for (const day of days) {
        const age = (today - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
        expect(age, `${day} at ${now.toISOString()}`).toBeGreaterThanOrEqual(0);
        expect(age, `${day} at ${now.toISOString()}`).toBeLessThan(7);
      }
    }
  });

  it("leaves a conversation it does not spread at the run's own instant", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(novaFirstInboundAt(now, E2E.namelessConversationId).getTime()).toBe(now.getTime());
  });
});
