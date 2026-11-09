/**
 * Test design (testing-strategy)
 *
 * Setup: pure inHalfOpenPeriod / bucketKey / medianMs / p90Ms /
 * firstResponseStats / buildReport. No HTTP, no DB.
 *
 * Oracle: openspec/changes/relatorios-remainder-metrics/specs/relatorios/spec.md
 *   + design.md D2/D3/D5 (even-n median = average of two middles; p90
 *   nearest-rank ceil(0.9*n); period half-open [start, end)).
 *
 * Subsequent sample (D2, quoted): for every inbound that has a later outbound
 * in the same conversation, duration is (first outbound with
 * providerTimestamp > inbound) − inbound. Consecutive inbounds are NOT
 * collapsed. Scoped to novas in the cut (D5).
 *
 * Unanswered: inbound with shouldReply:true and no later outbound;
 * wait = now − oldest such inbound (should-reply-window / amended REP-03).
 * Unlabeled and false do not count. No period predicate. Unit / origin /
 * tag / campaign filters still apply.
 *
 * Techniques: EP, BVA on period instants, decision table for nova membership
 * (collapsed: unit mismatch is dominant), decision coverage of aggregate.ts.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 unitId match — yes / no. No BVA.
 * A2 origin — omitted (todas) | AD | ORGANIC | UNKNOWN vs row AD/ORGANIC/UNKNOWN
 * A3 firstInboundAt — null (not nova) | in window | outside window
 * A4 period instant vs [start, end)
 *   BVA: start−1 excluded, start included, end−1 included, end excluded
 * A5 firstOutboundAt — present (eligible + cobertura) / null (out of stats)
 * A6 granularity — day | week | month
 * A7 subsequent pairing — two inbounds + one later outbound / inbound with
 *    no later outbound / outbound with same timestamp (strict >)
 * A8 ativa messages — two same-day / two days / none in period
 * A9 unanswered shouldReply — true pending / false / unlabeled / later outbound
 * A12 unanswered items cap — 100 kept, 101st dropped, count full
 * A13 wait from oldest of two pending true inbounds
 * A11 scheduled D3 — SCHEDULED/CANCELLED by scheduledAt; SENT/FAILED by
 *     sentAt; SENT missing sentAt excluded; PROCESSING ignored
 * A12 unanswered items cap — 100 kept, 101st dropped, count full
 *
 * Outputs: O1 counted nova; O2 not counted; O3 stats on eligible set; O4 null stats
 *
 * Nova membership 2^4 (C1 unit, C2 origin ok, C3 inbound set, C4 in period):
 *   C1 F → O2 (dominant). Sampled: other unit.
 *   C1 T C2 F → O2. Sampled: ORGANIC filter + UNKNOWN row; AD filter + UNKNOWN.
 *   C1 T C2 T C3 F → O2. Sampled: null inbound.
 *   C1 T C2 T C3 T C4 F → O2. Sampled: 2024 inbound in Aug 2026; start−1; end.
 *   All T → O1.
 *   Not expanded to 16 `it`s: remaining combos are the same actions.
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * | `it` | fails if |
 * | includes start and excludes end | start not nova or end is nova |
 * | instant 1ms before start is excluded | counted |
 * | instant 1ms before end is included | not counted |
 * | Sunday vs Monday week buckets | same key |
 * | month bucket is first of São Paulo month | not YYYY-MM-01 |
 * | odd-n median / even-n median / empty median | wrong middle rule |
 * | p90 empty / n=3 nearest-rank | p90 not last of [100,200,300] |
 * | 2024 inbound out of Aug 2026 | counted as nova |
 * | other unit excluded | both units counted |
 * | null inbound excluded | counted |
 * | ORGANIC excludes UNKNOWN | count 2 |
 * | UNKNOWN filter keeps only UNKNOWN | ORGANIC counted |
 * | AD filter on UNKNOWN → 0 | count > 0 |
 * | AD row counted under AD filter | count 0 |
 * | todas includes mixed origins | count ≠ 3 |
 * | unanswered lowers cobertura 1/2 | eligibleCount 2 or cobertura 2/2 |
 * | two novas same day one bucket | two day rows |
 * | three days no double-count | sum ≠ 3 |
 * | 2024→2026 wait in stats | meanMs ≠ elapsed |
 * | two inbounds one outbound → two durations | one sample or collapsed |
 * | inbound without outbound excluded from mean | meanMs 0 |
 * | two same-day messages → active 1 | active 2 |
 * | ORGANIC filter drops UNKNOWN ativa | UNKNOWN in active count |
 * | last outbound not unanswered | B in items |
 * | respondidas 1/2 | answered 2 or total ≠ 2 |
 * | campaign omits UNKNOWN without ids | two rows or UNKNOWN included |
 * | scheduled zeros | invented success totals presented as non-zero |
 * | SENT without sentAt excluded | counted in sent |
 * | 101 unanswered → items 100 count 101 | items 101 or count 100 |
 * | non-nova messages skip subsequent | extra duration from old convo |
 *
 * ----------------------------------------------------------------------------
 * Decision map (aggregate.ts)
 * ----------------------------------------------------------------------------
 * D1 instant >= start (inHalfOpenPeriod) T: start, end−1, in-window novas; F: start−1
 * D2 instant < end T: start, end−1; F: end
 * D3 granularity === "day" T: day double-count / same-day; F: week and month tests
 * D4 granularity === "month" (after D3 F) T: month bucket; F: week bucket
 * D5 median length===0 T: medianMs([]); F: odd/even n
 * D6 length % 2 === 1 T: n=3; F: n=2
 * D7 p90 length===0 T: p90Ms([]); F: n=3
 * D8 firstResponseStats empty T: []; F: three durations / unanswered pair
 * D9 row.unitId !== unitId T: other unit; F: unit-a rows
 * D10 query.sourceType falsy T (skip filter): todas; F then mismatch: ORGANIC+UNKNOWN
 * D11 !firstInboundAt T: null inbound; F: every timed row
 * D12 in period (filter return) T/F via A4
 * D13 bucket get ?? 0 — F (new key) three different days; T (increment) same-day pair
 * D14 outbound && inbound T: answered; F: unanswered nova
 * D15 map[weekday] ?? 0 — unknown weekday infeasible (Intl weekday is Mon–Sun)
 * D16 query.tagId && !matching active tag T: tag miss; F: omitted tagId / match
 * D17 query.campaignId && mismatch T: campaign miss; F: omitted / match
 * D18 subsequent inbound loop / outbound find T: two-in-one-out; F: inbound only
 * D19 shouldReply true pending T: unanswered A; F: false / unlabeled / last outbound
 * D20 campaignId present T: AD with id; F: UNKNOWN without ids
 * D21 tag.active T: counted; F: inactive skipped
 * D22 scheduled SCHEDULED/CANCELLED by scheduledAt T/F via A11
 * D23 SENT/FAILED !sentAt T: exclude; F: sentAt in window
 * D24 PROCESSING ignored T: status other; F: four counted statuses
 * D25 unanswered slice cap T: 101 rows; F: count ≤ 100
 *
 * Out of scope: HTTP (reports.route.test.ts); Prisma (prisma.test.ts); UI copy.
 *
 * Split from `apps/api/src/reports/aggregate.test.ts` when the reports module
 * moved under the 300-line cap; assertions are unchanged. Siblings:
 * calendar.test.ts, response-times.test.ts, build-report-novas.test.ts,
 * build-report-activity.test.ts, build-report-breakdowns.test.ts. Pure: runs
 * under no module role.
 * This half holds the buildReport cases for: nova membership, origin filters, cobertura, day buckets.
 */

import { describe, expect, it } from "vitest";
import { buildReport } from "./aggregate.js";
import { aug2026Query, row, unitA, unitB } from "./report-row.fixture.js";

describe("buildReport", () => {
  it("excludes a 2024 inbound from an August 2026 cut", () => {
    const result = buildReport(
      [
        row({
          firstInboundAt: new Date("2024-03-10T12:00:00.000Z"),
          firstOutboundAt: new Date("2026-08-10T12:00:00.000Z"),
        }),
      ],
      unitA,
      aug2026Query,
    );

    expect(result.newConversationCount).toBe(0);
  });

  it("counts only the requested unit", () => {
    const result = buildReport(
      [
        row({ firstInboundAt: new Date("2026-08-10T12:00:00.000Z") }),
        row({
          unitId: unitB,
          firstInboundAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
      ],
      unitA,
      aug2026Query,
    );

    expect(result.newConversationCount).toBe(1);
  });

  it("excludes a conversation with null firstInboundAt", () => {
    const result = buildReport(
      [
        {
          conversationId: "no-inbound",
          unitId: unitA,
          sourceType: "UNKNOWN",
          firstInboundAt: null,
          firstOutboundAt: new Date("2026-08-10T12:00:00.000Z"),
          campaignId: null,
          adSetId: null,
          adId: null,
          tags: [],
          messages: [],
          customerId: null,
        },
      ],
      unitA,
      aug2026Query,
    );

    expect(result.newConversationCount).toBe(0);
  });

  it("excludes UNKNOWN when origin filter is ORGANIC", () => {
    const result = buildReport(
      [
        row({
          sourceType: "ORGANIC",
          firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
        }),
        row({
          sourceType: "UNKNOWN",
          firstInboundAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
      ],
      unitA,
      { ...aug2026Query, sourceType: "ORGANIC" },
    );

    expect(result.newConversationCount).toBe(1);
  });

  it("keeps only UNKNOWN when origin filter is UNKNOWN", () => {
    const result = buildReport(
      [
        row({
          sourceType: "ORGANIC",
          firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
        }),
        row({
          sourceType: "UNKNOWN",
          firstInboundAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
      ],
      unitA,
      { ...aug2026Query, sourceType: "UNKNOWN" },
    );

    expect(result.newConversationCount).toBe(1);
  });

  it("returns zero novas for AD filter when all rows are UNKNOWN", () => {
    const result = buildReport(
      [row({ firstInboundAt: new Date("2026-08-10T12:00:00.000Z") })],
      unitA,
      { ...aug2026Query, sourceType: "AD" },
    );

    expect(result.newConversationCount).toBe(0);
    expect(result.coverage).toEqual({ answered: 0, total: 0 });
  });

  it("counts an AD row when origin filter is AD", () => {
    const result = buildReport(
      [
        row({
          sourceType: "AD",
          firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
        }),
      ],
      unitA,
      { ...aug2026Query, sourceType: "AD" },
    );

    expect(result.newConversationCount).toBe(1);
  });

  it("counts mixed origins when no origin filter is applied", () => {
    const result = buildReport(
      [
        row({
          sourceType: "AD",
          firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
        }),
        row({
          sourceType: "ORGANIC",
          firstInboundAt: new Date("2026-08-11T12:00:00.000Z"),
        }),
        row({
          sourceType: "UNKNOWN",
          firstInboundAt: new Date("2026-08-12T12:00:00.000Z"),
        }),
      ],
      unitA,
      aug2026Query,
    );

    expect(result.newConversationCount).toBe(3);
  });

  it("lowers cobertura when one of two novas is unanswered", () => {
    const result = buildReport(
      [
        row({
          firstInboundAt: new Date("2026-08-10T12:00:00.000Z"),
          firstOutboundAt: new Date("2026-08-10T13:00:00.000Z"),
        }),
        row({ firstInboundAt: new Date("2026-08-11T12:00:00.000Z") }),
      ],
      unitA,
      aug2026Query,
    );

    expect(result.coverage).toEqual({ answered: 1, total: 2 });
    expect(result.firstResponse.eligibleCount).toBe(1);
    expect(result.firstResponse.meanMs).toBe(3_600_000);
  });

  it("counts a multi-year wait in first-response stats", () => {
    const inbound = new Date("2024-01-01T12:00:00.000Z");
    const outbound = new Date("2026-01-01T12:00:00.000Z");
    const result = buildReport(
      [row({ firstInboundAt: inbound, firstOutboundAt: outbound })],
      unitA,
      {
        periodStart: "2024-01-01T00:00:00.000Z",
        periodEnd: "2025-01-01T00:00:00.000Z",
        granularity: "month",
      },
    );

    expect(result.firstResponse.eligibleCount).toBe(1);
    expect(result.firstResponse.meanMs).toBe(outbound.getTime() - inbound.getTime());
  });

  it("puts two same-day novas in one day bucket", () => {
    const result = buildReport(
      [
        row({ firstInboundAt: new Date("2026-08-10T12:00:00.000Z") }),
        row({ firstInboundAt: new Date("2026-08-10T18:00:00.000Z") }),
      ],
      unitA,
      { ...aug2026Query, granularity: "day" },
    );

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.newConversationCount).toBe(2);
  });

  it("does not double-count across day buckets", () => {
    const result = buildReport(
      [
        row({ firstInboundAt: new Date("2026-08-10T12:00:00.000Z") }),
        row({ firstInboundAt: new Date("2026-08-11T12:00:00.000Z") }),
        row({ firstInboundAt: new Date("2026-08-12T12:00:00.000Z") }),
      ],
      unitA,
      { ...aug2026Query, granularity: "day" },
    );

    const sum = result.buckets.reduce((acc, b) => acc + b.newConversationCount, 0);

    expect(sum).toBe(3);
    expect(result.buckets).toHaveLength(3);
  });
});
