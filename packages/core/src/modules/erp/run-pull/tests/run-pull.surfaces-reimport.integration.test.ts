/**
 * Test design (testing-strategy) — continues `run-pull.surfaces.integration.test.ts`
 *
 * The re-import, seeded-identifier and duplicate-pair cases of
 * `importMockSurfaces`, split by topic from the service-order file to stay under
 * the line cap. The design header there — axes, outputs, sampled cells, decision
 * map, the fake-only assertions it surfaced and the #106 history — covers these
 * five as well; the cells here are "second import", "seed then import" and the
 * duplicate-pair rows. Same stores, same roles (`module_customers`,
 * `module_services`, `module_quotes`, `module_erp`), same per-test catalog ids.
 *
 * Moved from `apps/worker/src/omie/import-surfaces.test.ts` (3A.3), assertions
 * unchanged but for the catalog ids, which each test renames.
 */
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import type { MockOmieSource, MockServiceOrder } from "../../../../kernel/clients/erp-mock.js";
import { scopedMockOmie } from "./scoped-mock.js";
import { importMockSurfaces } from "../import-surfaces.js";
import { pullOmieClients } from "../pull.js";
import { expect, it, vi } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroImportStore } from "../../../customers/contracts/import-from-erp.js";
import { createSyncRunRecorder } from "../../contracts/record-sync-run.js";
import { createSurfaceImportStore } from "../index.js";

/** The default test transaction: with scoped ids no case waits on another's rows. */
function inSurfaceTransaction<T>(client: PrismaClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return withTestTransaction(client, fn);
}

/** These tests create no unlinked customer, so their pulls match nothing: production's database-wide pass, scoped to none. */
const NO_CANDIDATES = { customerIds: [] };

/** The one OS id the mock dataset lists. */
const MOCK_OS_ID = "os-mock-1";
/** The catalog ids the mock dataset lists; each run renames them (see header). */
const MOCK_CATALOG_IDS = ["cat-motul-8100-5w30", "cat-tecfil-pel108", "cat-tecfil-gi50-7"];

/** All three real stores, bound to the test's transaction. */
function stores(tx: DbClient) {
  const db = createDb(tx, runInTransactionOnTx(tx));
  return {
    cadastro: createCadastroImportStore(db, {}),
    sync: createSyncRunRecorder(db),
    surfaces: createSurfaceImportStore(db),
  };
}

/**
 * The service rows for one OS id, with their line items.
 *
 * @param tx - The test transaction.
 * @param osId - The Omie OS id to read; defaults to the mock dataset's own.
 */
function mockServices(tx: DbClient, osId: string = MOCK_OS_ID) {
  return tx.service.findMany({
    where: { omieId: osId },
    include: { items: { orderBy: { id: "asc" } } },
  });
}

/** Catalog ids present among the given ids — scoped, because the table holds the shop's own. */
async function catalogIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogItem.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
  return rows.map((row) => row.id).sort();
}

/** Catalog ids among `ids` that carry a lubricant-detail row. */
async function lubricantIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogLubricant.findMany({
    where: { catalogItemId: { in: [...ids] } },
    select: { catalogItemId: true },
  });
  return rows.map((row) => row.catalogItemId).sort();
}

/** Catalog ids among `ids` that carry a filter-detail row. */
async function filterIds(tx: DbClient, ids: readonly string[]): Promise<string[]> {
  const rows = await tx.catalogFilter.findMany({
    where: { catalogItemId: { in: [...ids] } },
    select: { catalogItemId: true },
  });
  return rows.map((row) => row.catalogItemId).sort();
}

/**
 * Pulls the mock clients and imports the mock surfaces through the real stores.
 *
 * @param tx - The test transaction.
 * @param options - `emptyOs` drops the OS surface; `order` reshapes each listed OS;
 *   `osId` renames the listed OS, so an id no seed holds makes the import take
 *   its create path rather than its update path; `vehicleIds` replaces the
 *   vehicle-identifier surface.
 * @returns The stores, the import totals and the fetch spy.
 */
async function pullAndImport(
  tx: DbClient,
  options?: {
    emptyOs?: boolean;
    osId?: string;
    vehicleIds?: MockOmieSource["vehicleIds"];
    order?: (order: MockServiceOrder) => MockServiceOrder;
  },
) {
  await seedUnit(tx);
  const { cadastro, sync, surfaces } = stores(tx);
  const { source, id } = scopedMockOmie();
  if (options?.vehicleIds) {
    source.vehicleIds = options.vehicleIds;
  }
  if (options?.emptyOs) {
    source.serviceOrders = {
      async listByClient() {
        return [];
      },
    };
  } else if (options?.order || options?.osId) {
    const inner = source.serviceOrders;
    const shape = options.order ?? ((order: MockServiceOrder) => order);
    const osId = options.osId;
    source.serviceOrders = {
      async listByClient(clientOmieId: string) {
        return (await inner.listByClient(clientOmieId))
          .map(shape)
          .map((order) => (osId ? { ...order, omieId: osId } : order));
      },
    };
  }
  const fetchSpy = vi.fn();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;

  await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: source.clients, sync });
  const imported = await importMockSurfaces({ source, cadastro, surfaces, errors: sync });

  globalThis.fetch = previous;
  return { cadastro, sync, surfaces, imported, fetchSpy, id };
}

describeWithDatabase("importMockSurfaces — re-import and duplicates", () => {
  const db = () => prisma as PrismaClient;

  it("re-imports the same OS, product, and vehicle id without a second row", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      const { source, id } = scopedMockOmie();
      const ids = MOCK_CATALOG_IDS.map(id);

      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: source.clients, sync });
      await importMockSurfaces({ source, cadastro, surfaces, errors: sync });
      const second = await importMockSurfaces({ source, cadastro, surfaces, errors: sync });

      expect(await mockServices(tx, id(MOCK_OS_ID))).toHaveLength(1);
      expect(await catalogIds(tx, ids)).toEqual([...ids].sort());
      expect(await lubricantIds(tx, ids)).toEqual([id("cat-motul-8100-5w30")]);
      expect(await filterIds(tx, ids)).toHaveLength(2);
      const linked = await cadastro.findCustomerByOmieId(id("omie-mock-linked"));
      const vehicles = await cadastro.listVehicles(linked!.id);
      expect(vehicles.filter((row) => row.omieId === id("veh-omie-mock-1"))).toHaveLength(1);
      // A second import over rows the first already wrote creates nothing, which
      // is true whatever the database held beforehand.
      expect(second.created).toBe(0);
    }));

  it("does not add rows when mock identifiers are already seeded", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      const scope = scopedMockOmie();
      const { source, id } = scope;
      const ids = MOCK_CATALOG_IDS.map(id);
      const data = scope.data();
      const linked = data.clients.find((row) => row.omieId === id("omie-mock-linked"))!;
      // Make every mock identifier present before the import: upsert rather than
      // create. The ids are this test's own, so no other test or seed holds them.
      const seedCustomer = (omieId: string | null, name: string) =>
        omieId
          ? tx.customer.upsert({
              where: { omieId },
              create: { name, omieId, unitId: unit.id, origin: "CRM", status: "active" },
              update: { name },
            })
          : tx.customer.create({
              data: { name, unitId: unit.id, origin: "CRM", status: "active" },
            });
      // In the order the pull takes them (the fake lists clients sorted by Omie
      // id). That order once mattered: with the dataset's own ids, two files'
      // transactions each held one id and waited on the other's. Scoped ids make
      // that impossible, and the order is kept as it was.
      await seedCustomer(id("omie-mock-dup-a"), "Dup A");
      await seedCustomer(id("omie-mock-dup-b"), "Dup B");
      const linkedRow = await seedCustomer(linked.omieId, "Maria Linked");
      await seedCustomer(null, "Paulo Matchable");
      await tx.vehicle.create({
        data: {
          customerId: linkedRow.id,
          omieId: id("veh-omie-mock-1"),
          plate: "ABC1D23",
          origin: "omie",
        },
      });
      await surfaces.upsertServiceByOmieId(data.serviceOrders[0]!);
      for (const product of data.products) {
        await surfaces.upsertCatalogProduct(product);
      }

      const beforeServices = (await mockServices(tx, id(MOCK_OS_ID))).length;
      const beforeCatalog = (await catalogIds(tx, ids)).length;
      const beforeVehicles = (await cadastro.listVehicles(linkedRow.id)).length;

      const imported = await importMockSurfaces({ source, cadastro, surfaces, errors: sync });

      expect(imported.created).toBe(0);
      expect(beforeServices).toBe(1);
      expect(await mockServices(tx, id(MOCK_OS_ID))).toHaveLength(beforeServices);
      expect(await catalogIds(tx, ids)).toHaveLength(beforeCatalog);
      expect(await cadastro.listVehicles(linkedRow.id)).toHaveLength(beforeVehicles);
      expect(await cadastro.findCustomerByOmieId(id("omie-mock-dup-a"))).not.toBeNull();
      expect((await cadastro.findCustomerByOmieId(id("omie-mock-dup-a")))?.mergedIntoId).toBeNull();
    }));

  it("surfaces the duplicate pair and leaves both customers unmerged", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { cadastro, id } = await pullAndImport(tx);
      // This test's ids are its own, so nothing recorded this pair before the import.
      const correlationId = `${id("omie-mock-dup-a")}:${id("omie-mock-dup-b")}`;
      const before = 0;

      const left = await cadastro.findCustomerByOmieId(id("omie-mock-dup-a"));
      const right = await cadastro.findCustomerByOmieId(id("omie-mock-dup-b"));
      expect(left).not.toBeNull();
      expect(right).not.toBeNull();
      expect(left?.mergedIntoId).toBeNull();
      expect(right?.mergedIntoId).toBeNull();
      expect(
        await tx.integrationError.count({
          where: { code: "omie_duplicate_candidate", correlationId },
        }),
      ).toBe(before + 1);
    }));

  it("records the duplicate pair once, however often the mock is imported (#106)", () =>
    inSurfaceTransaction(db(), async (tx) => {
      // This assertion was `before + 2` while the guard was dead, deliberately,
      // so the fix could not land silently. It reads `before + 1` now: the
      // second import asks the store whether the pair is already recorded and
      // finds that it is. The first import's count is asserted separately, so a
      // guard that suppressed BOTH rows would fail here rather than look green.
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      const { source, id } = scopedMockOmie();
      const correlationId = `${id("omie-mock-dup-a")}:${id("omie-mock-dup-b")}`;
      const where = { code: "omie_duplicate_candidate", correlationId };
      const before = await tx.integrationError.count({ where });

      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: source.clients, sync });
      await importMockSurfaces({ source, cadastro, surfaces, errors: sync });
      const afterFirst = await tx.integrationError.count({ where });
      await importMockSurfaces({ source, cadastro, surfaces, errors: sync });

      expect(afterFirst).toBe(before + 1);
      expect(await tx.integrationError.count({ where })).toBe(before + 1);
    }));

  it("answers the recorded question for the pair it holds and no other", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      const { source, id } = scopedMockOmie();
      const correlationId = `${id("omie-mock-dup-a")}:${id("omie-mock-dup-b")}`;

      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: source.clients, sync });
      await importMockSurfaces({ source, cadastro, surfaces, errors: sync });

      // True for what was recorded, and false on each axis that should not
      // match: another pair, and the same pair under a different code. A guard
      // that ignored either would silence a finding rather than dedupe one.
      await expect(
        sync.hasRecordedError({ code: "omie_duplicate_candidate", correlationId }),
      ).resolves.toBe(true);
      await expect(
        sync.hasRecordedError({ code: "omie_duplicate_candidate", correlationId: "nobody:nobody" }),
      ).resolves.toBe(false);
      await expect(
        sync.hasRecordedError({ code: "omie_other_finding", correlationId }),
      ).resolves.toBe(false);
    }));

});
