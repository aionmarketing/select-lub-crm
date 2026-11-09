/**
 * Test design (testing-strategy)
 *
 * SUT: the `list-unit-services` slice's `listUnitServices` — the unit Serviços
 *   listing: its Prisma `where`, and the in-JS `selectUnitServicePage` that
 *   applies the exact São Paulo period, the return-state filter and the paging.
 *
 * Moved from `apps/api/src/services/unit-listing.test.ts` (adopt-modular-vertical-
 * slices 3C), 19 cases split by topic across this file (period, return state) and
 * `unit-listing-search.integration.test.ts` (search, paging and labels), with
 * the ledger in `unit-ledger.fixture.ts`. Assertions unchanged; the store the
 * cases call is the slice's function over the test transaction.
 *
 * Setup: `describeWithDatabase` + the local `itInTx`, which runs each body in a
 *   test transaction that always rolls back (openspec change
 *   route-tests-on-real-database, wave 2B). The five services, two customers,
 *   two vehicles and their returns are real rows in that transaction.
 *
 * Oracle: align-shipped-ui-to-revised-canvas customer-services delta —
 *   "Unit service listing is filtered, searched and paged"; "The return-state
 *   filter SHALL select services by the return state of the vehicle ... read
 *   from that vehicle's stored vehicle return"; "A service SHALL match only
 *   when it is the service its vehicle's return was dated from"; "An archived
 *   return SHALL still match"; "Search, date range and return-state filter
 *   SHALL compose".
 *
 * ASSERTIONS THAT ONLY HELD ON THE FAKE (required by the change)
 *   1. **The old "Prisma" store never ran a query.** `prismaStore()` built
 *      `createPrismaServicesStore` over a hand-rolled object whose
 *      `service.findMany` IGNORED its `where` argument and returned all five
 *      seeded rows every time, recording the clause in a module-level
 *      `lastWhere`. So every case that claimed to exercise the Prisma path was
 *      really exercising the in-JS `selectUnitServicePage` over an unfiltered
 *      list, and the two `where` assertions checked a data structure that
 *      nothing executed. Those two are replaced by the behaviour they were
 *      standing in for, which Postgres now actually performs:
 *        - `mode: "insensitive"` is asserted by searching a real column in the
 *          wrong case and getting the row, and by a term matching none;
 *        - the widened period bound is asserted by a single-day range that
 *          contains a service, which the coarse `gte/lte` must not clip before
 *          the exact São Paulo filter ever sees it.
 *      A `where` that named a column Postgres does not have, or a wrong
 *      `contains` shape, passed the old file and fails this one.
 *   2. **Two implementations agreed because one of them was inert.** The
 *      "memory and Prisma agree" block compared the memory store against that
 *      same non-querying stand-in over an identical hard-coded row list, so it
 *      could not have disagreed (memory:
 *      distinctness-assertions-need-a-resolution-check). There is one
 *      implementation now, so the block is gone rather than rewritten; what it
 *      actually checked — the labelled row carries the customer's name and the
 *      vehicle's plate — is asserted directly against the joined rows.
 *   3. **Ids and unit membership were Map keys.** `UNIT = "unit-1"`, `cus-ana`,
 *      `veh-a` existed only in the fakes. `service.unit_id`, `service.customer_id`
 *      and `vehicle_return.source_service_id` are FKs, so the ledger is now a
 *      real graph and a service cannot be scoped to a unit that does not exist.
 *
 * Axes
 *   A1 period bound: inside / outside / undated service under a bound / a single day
 *   A2 search term: customer name / plate / Omie id, differing case, partial
 *   A3 search composed with a period that excludes the match
 *   A4 paging: first page / continuation / boundary from dated into undated
 *   A5 return status: OPEN / ARCHIVED / SUPERSEDED
 *   A6 return-state value: vencido / aproximando / omitted
 *   A7 same vehicle, two services: the one its return was dated from / an older one
 *
 * Outputs: O1 the page's row ids in order; O2 hasMore/nextCursor/totalCount;
 *   O3 the labelled row's joined fields; O4 the row set the return-state filter
 *   selects
 *
 * Sampled-cell
 *   June range excludes January            | A1 | O1
 *   undated service under a bound          | A1 | O1
 *   single-day range keeps its service     | A1 | O1
 *   plate search, wrong case, partial      | A2 | O1
 *   omieId search                          | A2 | O1
 *   name search, wrong case                | A2 | O1
 *   search matching no column              | A2 | O1
 *   name search + excluding range          | A3 | O1
 *   two pages, no repeat, no skip          | A4 | O1,O2
 *   dated -> undated page boundary         | A4 | O1
 *   labelled row carries name and plate    | -  | O3
 *   vencido matches the current service    | A5 OPEN A6 vencido A7 current | O4
 *   older service of the same car excluded | A7 older                      | O4
 *   vencido vs aproximando disagree        | A6 both                       | O4
 *   archived return still matches          | A5 ARCHIVED                   | O4
 *   filter composes with search and period | A2 A1 A6                      | O4
 *   filter omitted returns the whole ledger| A6 omitted                    | O1
 *
 * Decision / branch map (internal/unit-listing.ts, contracts/return-state.ts)
 *   isFilterableReturn OPEN|ARCHIVED   T vencido/aproximando/archived its;
 *     F the superseded row, which s-mar carries in every case and which never appears
 *   classifyReturnDate vencido/aproximando/null  both branches across the vencido and
 *     aproximando its; null is every service with no return row
 *   query.returnState === undefined   T the omitted-filter it; F every filtered it
 *
 * Out of scope: HTTP routing (list-unit-services.integration.test.ts);
 *   classifyReturnDate's own boundary arithmetic (apps/api return-sections.test.ts,
 *   through Follow-up's sections).
 */
import { expect } from "vitest";
import { describeWithDatabase } from "@select-lub/core/testing";
import { itInTx, SEEDS, seedLedger } from "./unit-ledger.fixture.js";

describeWithDatabase("unit service listing — period", () => {
  itInTx("bounds the listing to the requested range", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { from: "2026-06-01", to: "2026-06-30" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jun"]);
  });

  itInTx("leaves an undated service out of a bounded period but in an unbounded one", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const bounded = await store.listUnitPage(unitId, { from: "2026-01-01", to: "2026-12-31" });
    const unbounded = await store.listUnitPage(unitId, {});

    expect(bounded.rows.map((row) => row.id)).not.toContain("s-undated-a");
    expect(unbounded.rows.map((row) => row.id)).toContain("s-undated-a");
  });

  itInTx("keeps a service inside a single-day range, whose bounds Postgres widens", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    // Replaces the old assertion on the `where` object's gte/lte instants. The
    // coarse bound Prisma sends is deliberately wider than the requested day,
    // because the exact São Paulo boundary is applied afterwards in JS; a bound
    // that clipped instead of widening would drop this row before the exact
    // filter ever saw it, and the query is now really executed.
    const page = await store.listUnitPage(unitId, { from: "2026-06-10", to: "2026-06-10" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jun"]);
  });
});

describeWithDatabase("unit service listing — return state", () => {
  itInTx("matches the service its vehicle's overdue return was dated from", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { returnState: "vencido" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jun"]);
  });

  itInTx("leaves out an older service of the same overdue vehicle", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { returnState: "vencido" });

    // s-mar is veh-a's earlier oil change. Its return was superseded by s-jun's,
    // so the car appears once — not once per past visit. This falls out of
    // matching on the return's source service rather than from a second rule.
    // Precondition: s-mar is in the ledger at all, so its absence here is the
    // filter's doing and not a missing row.
    expect((await store.listUnitPage(unitId, {})).rows.map((row) => row.id)).toContain("s-mar");
    expect(page.rows.map((row) => row.id)).not.toContain("s-mar");
  });

  itInTx("separates aproximando from vencido", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const soon = await store.listUnitPage(unitId, { returnState: "aproximando" });
    const late = await store.listUnitPage(unitId, { returnState: "vencido" });

    expect(soon.rows.map((row) => row.id)).toEqual(["s-jan"]);
    expect(late.rows.map((row) => row.id)).not.toContain("s-jan");
  });

  itInTx("still matches a return that was archived", async (tx) => {
    // Archiving hides the return from Follow-up's queue. Serviços is the
    // listing where nothing disappears, so the service stays findable here —
    // a deliberate divergence, decided 2026-09-04.
    const { unitId, store } = await seedLedger(tx, { junReturnStatus: "ARCHIVED" });

    const page = await store.listUnitPage(unitId, { returnState: "vencido" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jun"]);
  });

  itInTx("composes with the search box and the period", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const withSearch = await store.listUnitPage(unitId, {
      returnState: "vencido",
      search: "ABC-1D23",
    });
    const contradicting = await store.listUnitPage(unitId, {
      returnState: "vencido",
      search: "XYZ-4B56",
    });
    const outsidePeriod = await store.listUnitPage(unitId, {
      returnState: "vencido",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(withSearch.rows.map((row) => row.id)).toEqual(["s-jun"]);
    // Every filter must hold at once, so a plate belonging to the other car
    // empties the result rather than widening it.
    expect(contradicting.rows).toEqual([]);
    expect(outsidePeriod.rows).toEqual([]);
  });

  itInTx("returns the whole ledger when no return state is asked for", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, {});

    // The filter is opt-in: omitting it must not quietly cut the ledger down to
    // services that happen to carry a return. A delta, not a global count: the
    // unit was created in this transaction and holds only these rows.
    expect(page.rows).toHaveLength(SEEDS.length);
  });
});
