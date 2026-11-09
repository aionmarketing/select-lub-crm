/**
 * Test design (testing-strategy)
 *
 * Setup: pure inHalfOpenPeriod / bucketKey. No HTTP, no DB.
 *
 * Split from `apps/api/src/reports/aggregate.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Siblings:
 * calendar.test.ts, response-times.test.ts, build-report-novas.test.ts,
 * build-report-activity.test.ts. Pure: runs under no module role.
 *
 * Oracle: openspec/changes/relatorios-remainder-metrics design.md D5 (period
 *   half-open [start, end)); buckets in America/Sao_Paulo.
 *
 * Axes
 *   A4 period instant vs [start, end)
 *     BVA: start−1 excluded, start included, end−1 included, end excluded
 *   A6 granularity — week | month (day is exercised through buildReport)
 *
 * Sampled-cell
 * | `it` | fails if |
 * | includes start and excludes end | start not nova or end is nova |
 * | instant 1ms before start is excluded | counted |
 * | instant 1ms before end is included | not counted |
 * | Sunday vs Monday week buckets | same key |
 * | month bucket is first of São Paulo month | not YYYY-MM-01 |
 *
 * Decision map (calendar.ts)
 *   D1 instant >= start T: start, end−1; F: start−1
 *   D2 instant < end T: start, end−1; F: end
 *   D3 granularity === "day" — F here; T in build-report-novas.test.ts
 *   D4 granularity === "month" (after D3 F) T: month bucket; F: week bucket
 *   D15 map[weekday] ?? 0 — unknown weekday infeasible (Intl weekday is Mon–Sun)
 */

import { describe, expect, it } from "vitest";
import { bucketKey, inHalfOpenPeriod } from "./calendar.js";
import { end, start } from "./report-row.fixture.js";

describe("inHalfOpenPeriod", () => {
  it("includes start and excludes end", () => {
    expect(inHalfOpenPeriod(start, start, end)).toBe(true);
    expect(inHalfOpenPeriod(end, start, end)).toBe(false);
  });

  it("excludes an instant 1ms before start", () => {
    expect(inHalfOpenPeriod(new Date(start.getTime() - 1), start, end)).toBe(false);
  });

  it("includes an instant 1ms before end", () => {
    expect(inHalfOpenPeriod(new Date(end.getTime() - 1), start, end)).toBe(true);
  });
});

describe("bucketKey", () => {
  it("puts Sunday and following Monday in different week buckets", () => {
    const sunday = new Date("2026-08-23T15:00:00.000Z");
    const monday = new Date("2026-08-24T15:00:00.000Z");

    expect(bucketKey(sunday, "week")).not.toEqual(bucketKey(monday, "week"));
  });

  it("uses the first São Paulo day of the month as the month bucket", () => {
    expect(bucketKey(new Date("2026-08-15T15:00:00.000Z"), "month")).toBe("2026-08-01");
  });
});
