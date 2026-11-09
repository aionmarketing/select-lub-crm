/**
 * Test design (testing-strategy)
 *
 * Setup: pure functions in attribution.ts. No HTTP, no Prisma.
 *
 * Oracle: relatorios-attribution-metrics spec — 30-day default rule;
 * associations keep the version recorded at insert; REP-11 Omie-origin
 * only, SENT window, same customer or vehicle, count-once; REP-12
 * linked novas denominator, Omie service in window, bySource;
 * unlinked excluded; zero linked → total 0 (rate absent in UI).
 *
 * Axes
 *   A1 window membership — inside / exact 30d / 30d+1ms / 40d
 *   A2 origin — omieId set / crm+null omieId / null performedAt
 *   A3 duplicate SENT anchors — two in-window vs one
 *   A4 unit — matching vs other unit
 *   A5 REP-12 customerId — set vs null; sourceType AD/ORGANIC
 *   A6 rule version — v1 insert then v2 current
 *
 * Outputs: O1 insert/count; O2 skip; O3 version preserved
 *
 * Sampled-cell
 *   10d and 20d SENT → count 1     | A3 | O1 | counted twice
 *   40d SENT under 30d window      | A1 | O2 | counted
 *   exact 30d elapsed included     | A1 BVA | O1 | excluded
 *   30d+1ms excluded               | A1 BVA | O2 | counted
 *   crm origin excluded            | A2 | O2 | counted
 *   null performedAt excluded      | A2 | O2 | counted
 *   other-unit service excluded    | A4 | O2 | counted
 *   other-unit quote excluded      | A4 | O2 | counted
 *   existing quote pair skipped    | seen | O2 | duplicate row
 *   converted AD + unconverted ORG | A5 | O1 | UNKNOWN invented
 *   unlinked nova not in total     | A5 | O2 | in denominator
 *   existing v1 kept after v2      | A6 | O3 | rewritten to 2
 *   new candidate records v2       | A6 | O1 | records 1
 *   second insert is empty         | idempotent | O2 | duplicate row
 *
 * Decision map (quoteApprovalInserts leftovers)
 *   D-quote unit mismatch T: other-unit quote it; F: matching-unit insert
 *   D-seen.has(key) T: infeasible when existing rows are consistent
 *     (claimedServices already has that serviceId); F: first insert
 *   D-reduce version>best T: [v1,v2]; F: [v2,v1]
 *   D-SENT !sentAt T: null sentAt it; F: dated SENT its
 *   D-conversion !firstInboundAt T: contract-hidden (linkedNovas already
 *     drops those rows before conversionInserts)
 *
 * Out of scope: Prisma createMany; Relatórios copy.
 *
 * Split from `apps/api/src/reports/attribution.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Siblings:
 * attribution-rule.test.ts, scheduled-return-inserts.test.ts,
 * conversion-and-approval-inserts.test.ts. Pure: runs under no module role.
 * This file holds: REP-12 conversion inserts, linked novas, and quote-approval inserts.
 */
import { describe, expect, it } from "vitest";
import {
  conversionInserts,
  countAttribution,
  linkedNovas,
  quoteApprovalInserts,
} from "./attribution.js";
import { nova, omieService, query, ruleV1 } from "./attribution.fixture.js";

describe("conversionInserts and linkedNovas", () => {
  it("includes a converted AD nova and an unconverted ORGANIC nova in bySource", () => {
    const rows = [
      nova({
        conversationId: "conv-ad",
        sourceType: "AD",
        firstInboundAt: new Date("2026-08-08T12:00:00.000Z"),
      }),
      nova({
        conversationId: "conv-org",
        sourceType: "ORGANIC",
        customerId: "cust-2",
        firstInboundAt: new Date("2026-08-09T12:00:00.000Z"),
      }),
    ];
    const novas = linkedNovas(rows, "unit-a", query);
    const inserts = conversionInserts(
      novas,
      [
        omieService({
          id: "svc-ad",
          performedAt: new Date("2026-08-20T12:00:00.000Z"),
        }),
      ],
      [],
      ruleV1,
      "unit-a",
    );
    const counted = countAttribution(ruleV1, [omieService({ id: "svc-ad" })], [], inserts, novas, "unit-a", query);

    expect(counted.conversion).toEqual({
      converted: 1,
      total: 2,
      bySource: [
        { sourceType: "AD", converted: 1, total: 1 },
        { sourceType: "ORGANIC", converted: 0, total: 1 },
      ],
    });
  });

  it("excludes an unlinked nova from the denominator", () => {
    const rows = [
      nova({ conversationId: "conv-linked" }),
      nova({ conversationId: "conv-open", customerId: null }),
    ];
    const novas = linkedNovas(rows, "unit-a", query);

    expect(novas.map((row) => row.conversationId)).toEqual(["conv-linked"]);
    expect(
      countAttribution(ruleV1, [], [], [], novas, "unit-a", query).conversion.total,
    ).toBe(1);
  });

  it("returns total 0 when no nova has a customerId", () => {
    const novas = linkedNovas(
      [nova({ conversationId: "conv-open", customerId: null })],
      "unit-a",
      query,
    );

    expect(countAttribution(ruleV1, [], [], [], novas, "unit-a", query).conversion).toEqual({
      converted: 0,
      total: 0,
      bySource: [],
    });
  });
});

describe("quoteApprovalInserts", () => {
  const quote = {
    quoteId: "q-1",
    conversationId: "conv-1",
    customerId: "cust-1",
    unitId: "unit-a",
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
  };

  it("records a pair when the Omie service is inside the 30-day window", () => {
    const inserts = quoteApprovalInserts(
      [quote],
      [omieService({ id: "svc-1", performedAt: new Date("2026-08-20T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
    );

    expect(inserts).toEqual([{ serviceId: "svc-1", quoteId: "q-1", ruleVersion: 1 }]);
  });

  it("skips a service outside the window", () => {
    const inserts = quoteApprovalInserts(
      [quote],
      [omieService({ id: "svc-1", performedAt: new Date("2026-09-20T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
    );

    expect(inserts).toEqual([]);
  });

  it("skips a quote from another unit", () => {
    const inserts = quoteApprovalInserts(
      [{ ...quote, unitId: "unit-b" }],
      [omieService({ id: "svc-1", performedAt: new Date("2026-08-20T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
    );

    expect(inserts).toEqual([]);
  });

  it("returns no rows when the quote-service pair already exists", () => {
    const inserts = quoteApprovalInserts(
      [quote],
      [omieService({ id: "svc-1", performedAt: new Date("2026-08-20T12:00:00.000Z") })],
      [{ serviceId: "svc-1", quoteId: "q-1", ruleVersion: 1 }],
      ruleV1,
      "unit-a",
    );

    expect(inserts).toEqual([]);
  });

  it("keeps at most one quote per service", () => {
    const inserts = quoteApprovalInserts(
      [
        quote,
        { ...quote, quoteId: "q-2", createdAt: new Date("2026-08-11T12:00:00.000Z") },
      ],
      [omieService({ id: "svc-1", performedAt: new Date("2026-08-20T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
    );

    expect(inserts).toEqual([{ serviceId: "svc-1", quoteId: "q-1", ruleVersion: 1 }]);
  });
});
