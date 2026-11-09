/**
 * Test design (testing-strategy)
 *
 * Setup: createMockOmie(). fetch is stubbed. No Postgres.
 *
 * Oracle: omie-mock —
 *   Mock Omie source covers every Omie surface;
 *   Drifted client appears in the next incremental window;
 *   Drift is deterministic;
 *   Mocked dual change (Omie side) is arranged;
 *   Simulated outage fails reads.
 *
 * Axes
 *   A1 surface — clients / OS / products / vehicle ids / duplicates
 *   A2 drift — one client later alteredAt / undrifted stays out of window
 *   A3 outage — failReads on / off
 *
 * Outputs: O1 rows no fetch; O2 drifted id in filter; O3 same drift twice;
 *   O4 arrangeDualChange crmValue; O5 get throws
 *
 * Sampled-cell
 *   list+incluir clients           | A1 clients | O1 | fetch
 *   OS for linked client           | A1 OS      | O1 | empty / fetch
 *   products list                  | A1 prod    | O1 | fetch
 *   vehicle ids                    | A1 veh     | O1 | fetch
 *   duplicate pairs                | A1 dup     | O1 | fetch
 *   incremental after drift        | A2 window  | O2 | undrifted included
 *   same drift twice               | A2 det     | O3 | different cep
 *   arrangeDualChange              | A2 dual    | O4 | wrong field
 *   failReads                      | A3 on      | O5 | get succeeds
 *
 * Decision / branch map (source.ts + fake failReads)
 *   drift unknown omieId            T no-op (unsampled: callers use dataset ids);
 *     F drift linked it
 *   failReads                       T outage it; F surface its
 *   listPage alteredAfter           T incremental after drift; F first list
 *
 * Out of scope: worker import (group 4); GitHub #5/#29 real contracts.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockOmie } from "./source.js";

async function withFetchGuard(run: () => Promise<void>) {
  const fetchSpy = vi.fn();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;
  try {
    await run();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = previous;
  }
}

describe("createMockOmie surfaces", () => {
  it("serves client listing and include without a network connection", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie();
      const page = await mock.clients.listPage(1);
      const created = await mock.clients.incluir({
        codigoIntegracao: "crm-1",
        snapshot: (await mock.clients.get("omie-mock-linked"))!,
      });

      expect(page.clients.some((row) => row.omieId === "omie-mock-linked")).toBe(true);
      expect(created.omieId).toBe("fake-crm-1");
    });
  });

  it("returns service orders, products, vehicle ids, and duplicate pairs without a network connection", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie();

      expect(await mock.serviceOrders.listByClient("omie-mock-linked")).toEqual([
        expect.objectContaining({ omieId: "os-mock-1" }),
      ]);
      expect(await mock.serviceOrders.listByClient("unknown")).toEqual([]);
      expect((await mock.products.listProducts())[0]?.omieId).toBe("cat-motul-8100-5w30");
      expect((await mock.vehicleIds.listVehicleIds())[0]?.vehicleOmieId).toBe("veh-omie-mock-1");
      expect(await mock.duplicates.listDuplicatePairs()).toEqual([
        { leftOmieId: "omie-mock-dup-a", rightOmieId: "omie-mock-dup-b" },
      ]);
    });
  });
});

describe("createMockOmie controls", () => {
  it("includes a drifted client in the next incremental window and omits an undrifted one", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie();
      const watermark = "2026-08-01T00:00:00.000Z";
      await mock.driftClient("omie-mock-linked", {
        razao_social: "Maria Drifted",
        alteredAt: "2026-09-01T00:00:00.000Z",
      });

      const listed = await mock.clients.listPage(1, { alteredAfter: watermark });
      const ids = listed.clients.map((row) => row.omieId);

      expect(ids).toContain("omie-mock-linked");
      expect(ids).not.toContain("omie-mock-matchable");
      expect((await mock.clients.get("omie-mock-linked"))?.razao_social).toBe("Maria Drifted");
    });
  });

  it("applies the same drift instruction to the same starting dataset twice", async () => {
    await withFetchGuard(async () => {
      const first = createMockOmie();
      const second = createMockOmie();
      const patch = { cep: "13020000", alteredAt: "2026-09-01T15:00:00.000Z" as const };

      await first.driftClient("omie-mock-linked", patch);
      await second.driftClient("omie-mock-linked", patch);

      expect(await first.clients.get("omie-mock-linked")).toEqual(
        await second.clients.get("omie-mock-linked"),
      );
    });
  });

  it("arrangeDualChange drifts Omie cep and names the un-pushed CRM postalCode", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie();
      const arranged = await mock.arrangeDualChange("omie-mock-linked");

      expect(arranged).toEqual({ fieldKey: "postalCode", crmValue: "CRMCEP12" });
      expect((await mock.clients.get("omie-mock-linked"))?.cep).toBe("OMIECEP1");
    });
  });

  it("failReads makes client gets throw without fetching", async () => {
    await withFetchGuard(async () => {
      const mock = createMockOmie();
      mock.failReads();

      await expect(mock.clients.get("omie-mock-linked")).rejects.toThrow("omie_unavailable");
    });
  });
});

describe("createMockOmie with an id prefix", () => {
  it("prefixes every Omie id and every reference to one, and nothing else", async () => {
    const plain = createMockOmie();
    const mock = createMockOmie(process.env, { idPrefix: "t1-" });

    // A reference still resolves: the OS hangs off the prefixed client, not the plain one.
    expect(await mock.serviceOrders.listByClient("t1-omie-mock-linked")).toEqual([
      expect.objectContaining({ omieId: "t1-os-mock-1", clientOmieId: "t1-omie-mock-linked", vehicleOmieId: "t1-veh-omie-mock-1" }),
    ]);
    expect(await mock.serviceOrders.listByClient("omie-mock-linked")).toEqual([]);
    expect(await mock.clients.get("t1-omie-mock-linked")).toEqual(await plain.clients.get("omie-mock-linked"));
    expect((await mock.products.listProducts())[0]?.omieId).toBe("t1-cat-motul-8100-5w30");
    expect((await mock.vehicleIds.listVehicleIds())[0]).toEqual({
      ...(await plain.vehicleIds.listVehicleIds())[0],
      vehicleOmieId: "t1-veh-omie-mock-1",
      clientOmieId: "t1-omie-mock-linked",
    });
    expect(await mock.duplicates.listDuplicatePairs()).toEqual([
      { leftOmieId: "t1-omie-mock-dup-a", rightOmieId: "t1-omie-mock-dup-b" },
    ]);
  });
});
