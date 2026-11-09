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
 * This file holds: REP-11 scheduled-return inserts.
 */
import { describe, expect, it } from "vitest";
import { countAttribution, scheduledReturnInserts } from "./attribution.js";
import { omieService, query, ruleV1, ruleV2, sentAnchor } from "./attribution.fixture.js";

describe("scheduledReturnInserts", () => {
  it("counts one Omie service once when two SENT messages fall inside the 30-day window", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-1" })],
      [
        sentAnchor({ id: "sm-10", sentAt: new Date("2026-08-10T12:00:00.000Z") }),
        sentAnchor({ id: "sm-20", sentAt: new Date("2026-07-31T12:00:00.000Z") }),
      ],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toHaveLength(2);
    const counted = countAttribution(ruleV1, [omieService({ id: "svc-1" })], inserts, [], [], "unit-a", query);
    expect(counted.scheduledReturn.count).toBe(1);
  });

  it("does not insert when the only SENT message is 40 days before the service under a 30-day window", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-1" })],
      [sentAnchor({ id: "sm-40", sentAt: new Date("2026-07-11T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toEqual([]);
  });

  it("does not insert a crm-origin service with null omieId", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-crm", omieId: null, origin: "crm" })],
      [sentAnchor({ id: "sm-1", sentAt: new Date("2026-08-15T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toEqual([]);
  });

  it("does not insert a SENT message with null sentAt", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-1" })],
      [sentAnchor({ id: "sm-open", sentAt: null })],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toEqual([]);
  });

  it("does not insert when performedAt is null", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-open", performedAt: null })],
      [sentAnchor({ id: "sm-1", sentAt: new Date("2026-08-15T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toEqual([]);
  });

  it("does not insert a service from another unit", () => {
    const inserts = scheduledReturnInserts(
      [omieService({ id: "svc-b", unitId: "unit-b" })],
      [sentAnchor({ id: "sm-1", sentAt: new Date("2026-08-15T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
      query,
    );

    expect(inserts).toEqual([]);
  });

  it("returns no rows on a second pass with the same existing pairs", () => {
    const first = scheduledReturnInserts(
      [omieService({ id: "svc-1" })],
      [sentAnchor({ id: "sm-1", sentAt: new Date("2026-08-15T12:00:00.000Z") })],
      [],
      ruleV1,
      "unit-a",
      query,
    );
    const second = scheduledReturnInserts(
      [omieService({ id: "svc-1" })],
      [sentAnchor({ id: "sm-1", sentAt: new Date("2026-08-15T12:00:00.000Z") })],
      first,
      ruleV1,
      "unit-a",
      query,
    );

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("keeps a version-1 association and records version 2 on a new candidate", () => {
    const existing: { serviceId: string; scheduledMessageId: string; ruleVersion: number }[] = [
      { serviceId: "svc-old", scheduledMessageId: "sm-old", ruleVersion: 1 },
    ];
    const inserts = scheduledReturnInserts(
      [
        omieService({ id: "svc-old", performedAt: new Date("2026-08-05T12:00:00.000Z") }),
        omieService({
          id: "svc-new",
          omieId: "omie-os-2",
          performedAt: new Date("2026-08-25T12:00:00.000Z"),
        }),
      ],
      [
        sentAnchor({ id: "sm-old", sentAt: new Date("2026-08-01T12:00:00.000Z") }),
        sentAnchor({ id: "sm-new", sentAt: new Date("2026-08-20T12:00:00.000Z") }),
      ],
      existing,
      ruleV2,
      "unit-a",
      query,
    );

    expect(existing[0]?.ruleVersion).toBe(1);
    expect(inserts).toEqual([
      { serviceId: "svc-new", scheduledMessageId: "sm-new", ruleVersion: 2 },
    ]);
  });
});
