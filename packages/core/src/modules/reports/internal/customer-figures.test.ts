/**
 * Test design (testing-strategy)
 *
 * Setup: pure functions in insights.ts. No HTTP, no Prisma.
 *
 * Oracle: relatorios-funnel-insights — primary KPIs + equal-length deltas
 * (absent when previous is 0); approval absent at zero quotes; funnel
 * nested subsets 100/80/30/12; origin exactly three rows; lapsed customers and
 * average revenue follow the period (both absent when nobody had a service in it); return date = Follow-up suggestDate / +6 months.
 *
 * Axes
 *   A1 previous period — 10 leads / 0 leads
 *   A2 quotes in period — 0 / 1 approved
 *   A3 funnel nesting — 100/80/30/12
 *   A4 origin — AD / ORGANIC / UNKNOWN
 *   A5 lapse timing — due inside the period / before it / moved past it by a newer service; revenue over the period's customers only
 *   A6 (align-shipped-ui-to-pdf-artboards) customer counts — 7 lapsed of 39
 *      with a service, 32 served in the period / nobody served (all null)
 *
 * Outputs: O1 deltaPct; O2 omitted delta; O3 null approval; O4 funnel; O5 origin; O6 churn;
 *   O7 the three counts beside the rates, copied unchanged onto insights.secondary
 *
 * Decision map (churnAndLtv): `inPeriod.size === 0` — T: absent-values it and
 * the other-unit it (nulls for all five); F: every counting it. The
 * `rows.filter(isOmieOrigin)` in the revenue sum is one-sided here (every
 * fixture service is Omie-origin) — the crm-origin exclusion is covered by
 * attribution.test.ts, which owns `isOmieOrigin`'s inputs.
 *
 * Added (align-shipped-ui-to-pdf-artboards, downstream-invariant check):
 * `inPeriod.size === 0` gates all five return fields together by
 * construction (inPeriod is a filtered subset of byCustomer, so one can
 * only be empty without the other being empty too) — pinned directly so a
 * downstream reader's "lapsedCustomers non-null / customersWithService
 * falsy is infeasible" claim has a producer-side test, not just a comment.
 *
 * Split from `apps/api/src/reports/insights.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Sibling:
 * insights.test.ts. Pure: runs under no module role.
 */
import { describe, expect, it } from "vitest";
import type { AttributionServiceRow } from "./attribution.js";
import { churnAndLtv } from "./customer-figures.js";

describe("churnAndLtv (Clientes perdidos no período / Receita média por cliente)", () => {
  // Period: June 2026. A service on 2025-12-15 with no rules falls due six months
  // later (BR-06) on 2026-06-15, inside June; one on 2025-06-30 fell due on 2025-12-30, before it. (Dec 31 + 6 months rolls to Jul 1, the exclusive end — avoided on purpose.)
  const periodStart = new Date("2026-06-01T03:00:00.000Z");
  const periodEnd = new Date("2026-07-01T03:00:00.000Z");
  const absent = {
    churnRate: null,
    ltv: null,
    lapsedCustomers: null,
    customersWithService: null,
    customersServedInPeriod: null,
  };
  const service = (
    id: string,
    customerId: string,
    performedAt: string,
    amount: number,
    extra: Partial<AttributionServiceRow> = {},
  ) => ({
    id,
    unitId: "unit-a",
    customerId,
    vehicleId: null,
    omieId: `omie-${id}`,
    origin: "omie",
    performedAt: new Date(performedAt),
    amount,
    ...extra,
  });

  it("counts a customer whose latest return fell due inside the period and no newer service followed", () => {
    const result = churnAndLtv(
      [service("svc-1", "cust-1", "2025-12-15T12:00:00.000Z", 200), service("svc-2", "cust-2", "2026-06-10T12:00:00.000Z", 300)],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result.churnRate).toBe(0.5);
    expect(result.ltv).toBe(300);
  });

  it("does not count a customer who fell due before the period began, even though they are still lapsed", () => {
    const result = churnAndLtv(
      [service("svc-1", "cust-1", "2025-06-30T12:00:00.000Z", 200), service("svc-2", "cust-2", "2026-06-10T12:00:00.000Z", 300)],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result.churnRate).toBe(0);
  });

  it("does not count a customer whose newer service moved the return past the period", () => {
    const result = churnAndLtv(
      [
        service("svc-1", "cust-1", "2025-12-15T12:00:00.000Z", 200),
        service("svc-3", "cust-1", "2026-06-05T12:00:00.000Z", 250),
        service("svc-2", "cust-2", "2026-06-10T12:00:00.000Z", 300),
      ],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result.churnRate).toBe(0);
    expect(result.ltv).toBe(275);
  });

  it("divides the period's Omie revenue by the period's customers, not by every customer ever", () => {
    const result = churnAndLtv(
      [
        service("svc-old", "cust-1", "2025-01-15T12:00:00.000Z", 1000),
        service("svc-2", "cust-2", "2026-06-03T12:00:00.000Z", 100),
        service("svc-3", "cust-3", "2026-06-20T12:00:00.000Z", 200),
      ],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result.ltv).toBe(150);
  });

  it("returns absent values, not zero, when nobody had a service in the period", () => {
    const result = churnAndLtv(
      [service("svc-1", "cust-1", "2025-12-15T12:00:00.000Z", 200)],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result).toEqual(absent);
    expect(churnAndLtv([], "unit-a", [], periodStart, periodEnd)).toEqual(absent);
  });

  it("reports the lapsed count, its base and the period's divisor as the screen prints them", () => {
    // 7 customers whose only service fell due inside June (lapsed), 32 served
    // in June: 39 with a service, 7 lapsed of them (18%), revenue over 32.
    const services = [
      ...Array.from({ length: 7 }, (_, i) =>
        service(`svc-lapsed-${i}`, `cust-lapsed-${i}`, "2025-12-15T12:00:00.000Z", 100),
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        service(`svc-served-${i}`, `cust-served-${i}`, "2026-06-10T12:00:00.000Z", 320),
      ),
    ];

    const result = churnAndLtv(services, "unit-a", [], periodStart, periodEnd);

    expect(result).toEqual({
      churnRate: 7 / 39,
      ltv: 320,
      lapsedCustomers: 7,
      customersWithService: 39,
      customersServedInPeriod: 32,
    });
  });

  it("never returns lapsedCustomers non-null while customersWithService is falsy", () => {
    // A downstream reader (Relatórios lapsedCaption) treats that combination
    // as infeasible. It is: inPeriod is built by filtering byCustomer's own
    // entries, so inPeriod.size > 0 (the only way past the early null
    // return) implies byCustomer.size — customersWithService — is also > 0.
    // Pinned at the producer rather than only in the consumer's comment.
    const withService = churnAndLtv(
      [service("svc-1", "cust-1", "2026-06-10T12:00:00.000Z", 100)],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );
    expect(withService.lapsedCustomers).not.toBeNull();
    expect(withService.customersWithService).not.toBeNull();
    expect(withService.customersWithService).toBeGreaterThan(0);

    const withNone = churnAndLtv([], "unit-a", [], periodStart, periodEnd);
    expect(withNone.lapsedCustomers).toBeNull();
    expect(withNone.customersWithService).toBeNull();
  });

  it("ignores another unit's services entirely", () => {
    const result = churnAndLtv(
      [service("svc-b", "cust-9", "2026-06-10T12:00:00.000Z", 999, { unitId: "unit-b" })],
      "unit-a",
      [],
      periodStart,
      periodEnd,
    );

    expect(result).toEqual(absent);
  });
});
