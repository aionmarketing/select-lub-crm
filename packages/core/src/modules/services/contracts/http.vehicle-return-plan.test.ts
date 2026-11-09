/**
 * Test design (testing-strategy)
 *
 * SUT: planVehicleReturns — pure, no clock, no I/O. Given one vehicle's
 * services, its OPEN returns and the interval rules, it returns rows to
 * supersede plus the row to open.
 *
 * Oracle: vehicle-returns — "at most one OPEN return per vehicle, sourced from
 *   its most recent dated service"; "recording a service opens a return dated
 *   performedAt + the matching rule else six months"; "a newer service
 *   supersedes the previous open return rather than leaving two"; "a service
 *   with no performedAt opens no return"; and "the stored returnDate is
 *   authoritative and editable" — which is why an already-correct open return is
 *   left untouched instead of being re-dated.
 *
 * Axes
 *   A1 dated services — none / one / several. Ordered by performedAt, so BVA
 *      applies on "which one wins": the latest, and one a day older.
 *   A2 services with no performedAt — absent / present alongside dated ones /
 *      the only kind present
 *   A3 open returns — none / one from the latest service / one from an older
 *      service / two at once (invariant already violated)
 *   A4 interval rule matches the service kind — exactly one matches / none does
 *      (six-month default). Yes/no domain, no BVA row.
 *
 * Outputs
 *   O1 open.sourceServiceId is the latest dated service
 *   O2 open.returnDate = performedAt + interval (rule) or + 6 months (default)
 *   O3 open is null — nothing should be open
 *   O4 supersede carries exactly the stale open-return ids
 *   O5 plan is empty ({supersede: [], open: null}) — data already correct
 *
 * Sampled-cell (one row per it; `fails if` is exhaustive for that row)
 *   first service, no returns        | A1 one  A3 none      | O1 O2      | opens from an undated service / wrong date
 *   no rule matches the kind         | A4 none              | O2 6 months| a rule applied anyway
 *   one rule matches the kind        | A4 one               | O2 rule    | six-month default used instead
 *   latest of several wins           | A1 several           | O1 latest  | an older service dating the return
 *   one day older loses (BVA)        | A1 latest−1 day      | O1 latest  | ties or off-by-one picking the older
 *   undated service ignored          | A2 mixed             | O1 dated   | an undated service winning
 *   only undated services            | A2 only, A3 one      | O3 O4      | opening a return with no date
 *   no services at all               | A1 none, A3 one      | O3 O4      | leaving a stale return open
 *   open return from the latest      | A3 from latest       | O5         | re-opening / re-dating an edited row
 *   open return from an older one    | A3 from older        | O1 O4      | superseding nothing / opening nothing
 *   two open returns at once         | A3 two               | O4 both−1  | collapsing to zero or leaving two
 *
 * Decision / branch map (vehicle-return-plan.ts)
 *   dated.length === 0            T "no services", "only undated"; F every other it
 *   reduce picks later service    T "latest of several", "one day older"; F single-service its
 *   alreadyOpen found             T "open from the latest", "two open returns"; F "from an older", "no returns"
 *   row.id !== alreadyOpen?.id    T "two open returns", "from an older"; F "open from the latest"
 *
 * Out of scope: suggestDate's own rule-matching and calendar math, covered in
 *   return-due.test.ts — sampled here only through O2 to prove the planner
 *   passes kind and performedAt through, not to re-test the date engine.
 *   Persisting the plan (supersede/insert) belongs to the store that applies it.
 */
import { describe, expect, it } from "vitest";
import { planVehicleReturns } from "./http.vehicle-return-plan.js";
import type { IntervalRuleInput } from "./http.return-due.js";

const NO_RULES: IntervalRuleInput[] = [];

/** One active rule matching services of kind "troca-oleo" every 4 months. */
const FOUR_MONTH_RULE: IntervalRuleInput[] = [
  {
    id: "rule-1",
    version: 3,
    criterion: "kind",
    criterionId: "troca-oleo",
    intervalAmount: 4,
    intervalUnit: "months",
    priority: 1,
    active: true,
    validFrom: null,
    validTo: null,
  },
];

function service(id: string, performedAt: string | null, kind: string | null = null) {
  return { id, performedAt: performedAt === null ? null : new Date(performedAt), kind };
}

/** Calendar day of a planned return, in the zone the rule anchors to. */
function ymd(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

describe("planVehicleReturns", () => {
  it("opens a return from the only service, six months out when no rule matches", () => {
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z")],
      openReturns: [],
      rules: NO_RULES,
    });

    expect(plan.supersede).toEqual([]);
    expect(plan.open?.sourceServiceId).toBe("svc-1");
    expect(ymd(plan.open?.returnDate as Date)).toBe("2026-09-10");
    expect(plan.open?.intervalRuleId).toBeNull();
  });

  it("dates the return from the matching interval rule and records which rule won", () => {
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z", "troca-oleo")],
      openReturns: [],
      rules: FOUR_MONTH_RULE,
    });

    expect(ymd(plan.open?.returnDate as Date)).toBe("2026-07-10");
    expect(plan.open?.intervalRuleId).toBe("rule-1");
    expect(plan.open?.intervalRuleVersion).toBe(3);
  });

  it("dates the return from the latest service when the vehicle has several", () => {
    const plan = planVehicleReturns({
      services: [
        service("svc-old", "2025-01-05T12:00:00.000Z"),
        service("svc-latest", "2026-03-10T12:00:00.000Z"),
        service("svc-middle", "2025-08-20T12:00:00.000Z"),
      ],
      openReturns: [],
      rules: NO_RULES,
    });

    expect(plan.open?.sourceServiceId).toBe("svc-latest");
  });

  it("prefers the later service when two are one day apart", () => {
    const plan = planVehicleReturns({
      services: [
        service("svc-day-before", "2026-03-09T12:00:00.000Z"),
        service("svc-latest", "2026-03-10T12:00:00.000Z"),
      ],
      openReturns: [],
      rules: NO_RULES,
    });

    expect(plan.open?.sourceServiceId).toBe("svc-latest");
  });

  it("ignores services with no performedAt when a dated one exists", () => {
    const plan = planVehicleReturns({
      services: [service("svc-undated", null), service("svc-dated", "2026-03-10T12:00:00.000Z")],
      openReturns: [],
      rules: NO_RULES,
    });

    expect(plan.open?.sourceServiceId).toBe("svc-dated");
  });

  it("opens nothing and supersedes the stale row when every service is undated", () => {
    const plan = planVehicleReturns({
      services: [service("svc-undated", null)],
      openReturns: [{ id: "ret-1", sourceServiceId: "svc-undated" }],
      rules: NO_RULES,
    });

    expect(plan.open).toBeNull();
    expect(plan.supersede).toEqual(["ret-1"]);
  });

  it("opens nothing and supersedes the stale row when the vehicle has no services", () => {
    const plan = planVehicleReturns({
      services: [],
      openReturns: [{ id: "ret-1", sourceServiceId: "svc-gone" }],
      rules: NO_RULES,
    });

    expect(plan.open).toBeNull();
    expect(plan.supersede).toEqual(["ret-1"]);
  });

  it("plans nothing when the open return already comes from the latest service", () => {
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z")],
      openReturns: [{ id: "ret-1", sourceServiceId: "svc-1" }],
      rules: NO_RULES,
    });

    // Deliberately no re-dating: the stored returnDate is authoritative and may
    // have been edited for this vehicle. Re-opening would undo that edit on the
    // next import.
    expect(plan).toEqual({ supersede: [], open: null, merge: null });
  });

  it("supersedes a return sourced from an older service and opens one from the newer", () => {
    const plan = planVehicleReturns({
      services: [
        service("svc-old", "2025-09-01T12:00:00.000Z"),
        service("svc-new", "2026-03-10T12:00:00.000Z"),
      ],
      openReturns: [{ id: "ret-old", sourceServiceId: "svc-old" }],
      rules: NO_RULES,
    });

    expect(plan.supersede).toEqual(["ret-old"]);
    expect(plan.open?.sourceServiceId).toBe("svc-new");
  });

  it("collapses two open returns to the one sourced from the latest service", () => {
    const plan = planVehicleReturns({
      services: [
        service("svc-old", "2025-09-01T12:00:00.000Z"),
        service("svc-latest", "2026-03-10T12:00:00.000Z"),
      ],
      openReturns: [
        { id: "ret-old", sourceServiceId: "svc-old" },
        { id: "ret-latest", sourceServiceId: "svc-latest" },
      ],
      rules: NO_RULES,
    });

    expect(plan.supersede).toEqual(["ret-old"]);
    expect(plan.open).toBeNull();
  });

  it("keeps the oldest of two open returns on the latest service and merges the other into it", () => {
    // The same return twice, from two reconciles racing. The list comes oldest
    // first, and the first is kept.
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z")],
      openReturns: [
        { id: "ret-first", sourceServiceId: "svc-1" },
        { id: "ret-second", sourceServiceId: "svc-1" },
      ],
      rules: NO_RULES,
    });

    expect(plan).toEqual({
      supersede: ["ret-second"],
      open: null,
      merge: { into: "ret-first", from: ["ret-second"] },
    });
  });

  it("opens nothing when the latest service's return is archived", () => {
    // Archiving takes the return off Follow-up; an import must not put it back
    // as a new row (owner rulings, 2026-09-25).
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z")],
      openReturns: [],
      archivedReturns: [{ id: "ret-archived", sourceServiceId: "svc-1" }],
      rules: NO_RULES,
    });

    expect(plan).toEqual({ supersede: [], open: null, merge: null });
  });

  it("supersedes an archived return on an older service and opens one from the newer", () => {
    const plan = planVehicleReturns({
      services: [
        service("svc-old", "2025-09-01T12:00:00.000Z"),
        service("svc-new", "2026-03-10T12:00:00.000Z"),
      ],
      openReturns: [],
      archivedReturns: [{ id: "ret-archived", sourceServiceId: "svc-old" }],
      rules: NO_RULES,
    });

    expect(plan.supersede).toEqual(["ret-archived"]);
    expect(plan.open?.sourceServiceId).toBe("svc-new");
  });

  it("leaves an archived and an open return on the same latest service as they are", () => {
    // The pairs earlier imports left behind: the open one is what attendants
    // have been working from, so neither is touched.
    const plan = planVehicleReturns({
      services: [service("svc-1", "2026-03-10T12:00:00.000Z")],
      openReturns: [{ id: "ret-open", sourceServiceId: "svc-1" }],
      archivedReturns: [{ id: "ret-archived", sourceServiceId: "svc-1" }],
      rules: NO_RULES,
    });

    expect(plan).toEqual({ supersede: [], open: null, merge: null });
  });

  it("leaves an archived return alone when no service is dated", () => {
    const plan = planVehicleReturns({
      services: [service("svc-1", null)],
      openReturns: [{ id: "ret-open", sourceServiceId: "svc-1" }],
      archivedReturns: [{ id: "ret-archived", sourceServiceId: "svc-1" }],
      rules: NO_RULES,
    });

    expect(plan).toEqual({ supersede: ["ret-open"], open: null, merge: null });
  });
});
