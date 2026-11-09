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
 * This file holds: the current rule and the attribution window.
 */
import { describe, expect, it } from "vitest";
import { currentAttributionRule, inAttributionWindow } from "./attribution.js";
import { ruleV1, ruleV2 } from "./attribution.fixture.js";

describe("currentAttributionRule", () => {
  it("returns the 30-day version-1 default when no rows exist", () => {
    expect(currentAttributionRule([])).toEqual({ version: 1, windowDays: 30 });
  });

  it("picks the highest version as current without mutating the prior window", () => {
    const current = currentAttributionRule([ruleV1, ruleV2]);

    expect(current).toEqual(ruleV2);
    expect(ruleV1.windowDays).toBe(30);
  });

  it("keeps the current version when a later row is older", () => {
    expect(currentAttributionRule([ruleV2, ruleV1])).toEqual(ruleV2);
  });
});

describe("inAttributionWindow", () => {
  const sent = new Date("2026-07-21T12:00:00.000Z");

  it("includes an event exactly 30 elapsed days after the anchor", () => {
    const exact = new Date(sent.getTime() + 30 * 86_400_000);
    expect(inAttributionWindow(sent, exact, 30)).toBe(true);
  });

  it("excludes an event 1ms past the 30-day window", () => {
    const justOver = new Date(sent.getTime() + 30 * 86_400_000 + 1);
    expect(inAttributionWindow(sent, justOver, 30)).toBe(false);
  });
});
