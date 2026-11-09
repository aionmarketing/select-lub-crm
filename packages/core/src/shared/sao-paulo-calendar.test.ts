/**
 * Test design (testing-strategy)
 *
 * Setup: pure saoPauloCalendarDay / calendarDayKey / saoPauloDateKey. No DB.
 *
 * Oracle: AGENTS.md §0 — the business runs on America/Sao_Paulo; and the
 *   function's own contract, "a service at 21:00 BRT belongs to that day, not
 *   to the next one in UTC". São Paulo has observed no DST since 2019, so the
 *   offset under test is a fixed UTC−3.
 *
 * Axes
 *   A1 the instant's UTC day vs its São Paulo day — same / UTC already the next day
 *   A2 zero padding — single-digit month and day / double-digit
 *
 * Sampled-cell
 * | `it` | fails if |
 * | 21:00 BRT stays on its local day | the UTC day (the next one) is returned |
 * | 02:59 UTC is still the previous São Paulo day | the UTC day is returned |
 * | 03:00 UTC is the new São Paulo day | the previous day is returned |
 * | single digits are zero-padded | `2026-3-5` |
 *
 * Moved with the functions from `apps/api/src/reports/aggregate.ts`, which had
 * no direct test of `saoPauloDateKey`; the boundary cases are new.
 */
import { describe, expect, it } from "vitest";
import { calendarDayKey, saoPauloCalendarDay, saoPauloDateKey } from "./sao-paulo-calendar.js";

describe("saoPauloDateKey", () => {
  it("keeps a service at 21:00 BRT on its local day, not the next UTC day", () => {
    // 2026-08-10 21:00 BRT is 2026-08-11 00:00 UTC.
    expect(saoPauloDateKey(new Date("2026-08-11T00:00:00.000Z"))).toBe("2026-08-10");
  });

  it("puts 02:59 UTC on the previous São Paulo day", () => {
    expect(saoPauloDateKey(new Date("2026-08-11T02:59:59.999Z"))).toBe("2026-08-10");
  });

  it("puts 03:00 UTC on the new São Paulo day", () => {
    expect(saoPauloDateKey(new Date("2026-08-11T03:00:00.000Z"))).toBe("2026-08-11");
  });
});

describe("calendarDayKey", () => {
  it("zero-pads a single-digit month and day", () => {
    expect(calendarDayKey({ year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
  });

  it("round-trips the São Paulo day of an instant", () => {
    const day = saoPauloCalendarDay(new Date("2026-12-31T23:30:00.000Z"));
    expect(day).toEqual({ year: 2026, month: 12, day: 31 });
    expect(calendarDayKey(day)).toBe("2026-12-31");
  });
});
