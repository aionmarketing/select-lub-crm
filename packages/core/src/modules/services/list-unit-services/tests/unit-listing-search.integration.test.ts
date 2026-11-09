/**
 * Test design (testing-strategy)
 *
 * The search, paging and label cases of the unit Serviços listing, moved from
 * `apps/api/src/services/unit-listing.test.ts` (adopt-modular-vertical-slices
 * 3C) with assertions unchanged. The test design — axes, sampled cells, the
 * assertions that only held on the old fake — is in
 * `unit-listing-filters.integration.test.ts`; the ledger is
 * `unit-ledger.fixture.ts`.
 */
import { expect } from "vitest";
import { describeWithDatabase } from "@select-lub/core/testing";
import { itInTx, seedLedger } from "./unit-ledger.fixture.js";

describeWithDatabase("unit service listing — search", () => {
  itInTx("matches a vehicle plate partially and ignoring case", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    // Postgres performs this one now: the stored plate is "ABC-1D23" and the
    // term is lower case and partial, so `contains` with `mode: "insensitive"`
    // has to be both present and correct.
    const page = await store.listUnitPage(unitId, { search: "abc-1d" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jun", "s-mar"]);
  });

  itInTx("matches the Omie service identifier", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { search: "OS-700" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jan"]);
  });

  itInTx("matches a customer name partially and ignoring case", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { search: "bruno sal" });

    expect(page.rows.map((row) => row.id)).toEqual(["s-jan", "s-undated-a"]);
  });

  itInTx("returns nothing for a term that matches no name, plate or Omie id", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { search: "corolla" });

    // "Corolla" is the vehicle's MODEL, which is not one of the three searched
    // columns. On the old stand-in client the term was never applied at all, so
    // this case could not distinguish a working search from no search.
    expect(page.rows).toEqual([]);
  });

  itInTx("returns nothing when the search matches outside the requested period", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, {
      search: "Ana",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(page.rows).toEqual([]);
  });
});

describeWithDatabase("unit service listing — paging and labels", () => {
  itInTx("walks every row across pages without repeating or skipping one", async (tx) => {
    const { unitId, store } = await seedLedger(tx);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof store.listUnitPage>> = await store.listUnitPage(unitId, {
        limit: 2,
        cursor,
      });
      seen.push(...page.rows.map((row) => row.id));
      if (!page.hasMore) {
        break;
      }
      cursor = page.nextCursor ?? undefined;
    }

    // Dated newest-first, then the undated group by ascending id.
    expect(seen).toEqual(["s-jun", "s-mar", "s-jan", "s-undated-a", "s-undated-b"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  itInTx("reports totals over the whole match, not the page", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const first = await store.listUnitPage(unitId, { limit: 2 });
    const second = await store.listUnitPage(unitId, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const searched = await store.listUnitPage(unitId, { search: "OS-700" });

    expect(first.totalCount).toBe(5);
    expect(second.totalCount).toBe(5);
    expect(searched.totalCount).toBe(1);
  });

  itInTx("reports the continuation only while further rows match", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const first = await store.listUnitPage(unitId, { limit: 2 });
    const all = await store.listUnitPage(unitId, { limit: 50 });

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(all.hasMore).toBe(false);
    expect(all.nextCursor).toBeNull();
  });

  itInTx("crosses from the dated group into the undated one without losing a row", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const third = await store.listUnitPage(unitId, { limit: 3 });
    const rest = await store.listUnitPage(unitId, {
      limit: 3,
      cursor: third.nextCursor ?? undefined,
    });

    expect(third.rows.map((row) => row.id)).toEqual(["s-jun", "s-mar", "s-jan"]);
    expect(rest.rows.map((row) => row.id)).toEqual(["s-undated-a", "s-undated-b"]);
  });

  itInTx("labels each row with the joined customer name and vehicle plate", async (tx) => {
    const { unitId, store } = await seedLedger(tx);

    const page = await store.listUnitPage(unitId, { limit: 3 });

    // What the deleted "memory and Prisma agree" block was really checking: the
    // include reaches the two relations and the DTO carries them through.
    expect(page.rows[0]).toMatchObject({
      id: "s-jun",
      customerName: "Ana Beatriz",
      vehiclePlate: "ABC-1D23",
    });
    // And a service with no vehicle still lists, with no plate rather than no row.
    const all = await store.listUnitPage(unitId, { limit: 50 });
    expect(all.rows.find((row) => row.id === "s-undated-b")?.vehiclePlate).toBeNull();
  });
});
