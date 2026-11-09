/**
 * Test design (testing-strategy) — continues `run-pull.surfaces.integration.test.ts`
 *
 * The line-item cases of `importMockSurfaces` (axis A9, outputs O11–O14 in the
 * main file's header, which covers these four as well), split by topic from the
 * service-order file to stay under the line cap. Same stores, same roles
 * (`module_customers`, `module_services`, `module_quotes`, `module_erp`), same
 * per-test Omie ids (`scopedMockOmie`).
 *
 * Moved from `apps/worker/src/omie/import-surfaces.test.ts` (3A.3), assertions
 * unchanged.
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

/**
 * One line item as a plain comparable object.
 *
 * `unitAmount` and `lineAmount` are `Decimal(10, 2)` columns, so Prisma hands
 * back Decimal instances, not the numbers the in-memory importer stored.
 */
function itemShape(item: {
  description: string;
  kind: string | null;
  quantity: number | null;
  unitAmount: unknown;
  lineAmount: unknown;
  oilViscosity: string | null;
}) {
  return {
    description: item.description,
    kind: item.kind,
    quantity: item.quantity,
    unitAmount: item.unitAmount === null ? null : Number(item.unitAmount),
    lineAmount: item.lineAmount === null ? null : Number(item.lineAmount),
    oilViscosity: item.oilViscosity,
  };
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
  // The OS id the import wrote: this test's own, unless the case named one.
  const osId = options?.osId ?? id(MOCK_OS_ID);
  return { cadastro, sync, surfaces, imported, fetchSpy, osId };
}

describeWithDatabase("importMockSurfaces — line items", () => {
  const db = () => prisma as PrismaClient;

  it("persists two NF line items on the imported service", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { osId } = await pullAndImport(tx, {
        order: (order) => ({
          ...order,
          items: [
            {
              description: "OLEO RADNAQ 5W30",
              kind: "oleo",
              quantity: 4,
              unitAmount: 80,
              lineAmount: 320,
              oilViscosity: "5W30",
            },
            {
              description: "Filtro",
              kind: null,
              quantity: 1,
              unitAmount: 35,
              lineAmount: 35,
            },
          ],
        }),
      });

      const items = (await mockServices(tx, osId))[0]?.items ?? [];
      expect(items.map(itemShape)).toEqual([
        {
          description: "OLEO RADNAQ 5W30",
          kind: "oleo",
          quantity: 4,
          unitAmount: 80,
          lineAmount: 320,
          oilViscosity: "5W30",
        },
        {
          description: "Filtro",
          kind: null,
          quantity: 1,
          unitAmount: 35,
          lineAmount: 35,
          oilViscosity: null,
        },
      ]);
    }));

  it("stores an empty items list for a header-only order", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { osId } = await pullAndImport(tx, { order: (order) => ({ ...order, items: [] }) });

      expect((await mockServices(tx, osId))[0]?.items).toEqual([]);
    }));

  it("replaces stored items on re-import of the same mock service id", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      const scope = scopedMockOmie();
      const osId = scope.id(MOCK_OS_ID);
      const first = scope.source;
      const firstOrders = first.serviceOrders;
      first.serviceOrders = {
        async listByClient(clientOmieId: string) {
          const rows = await firstOrders.listByClient(clientOmieId);
          return rows.map((row) => ({
            ...row,
            items: [{ description: "old", kind: null, quantity: 1, unitAmount: 1, lineAmount: 1 }],
          }));
        },
      };
      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: first.clients, sync });
      await importMockSurfaces({ source: first, cadastro, surfaces, errors: sync });
      expect((await mockServices(tx, osId))[0]?.items.map((item) => item.description)).toEqual(["old"]);

      // The same ids as `first`, so this is a re-import of the same OS.
      const second = scope.another();
      const secondOrders = second.serviceOrders;
      second.serviceOrders = {
        async listByClient(clientOmieId: string) {
          const rows = await secondOrders.listByClient(clientOmieId);
          return rows.map((row) => ({
            ...row,
            items: [{ description: "new", kind: "oleo", quantity: 2, unitAmount: 3, lineAmount: 6 }],
          }));
        },
      };
      await importMockSurfaces({ source: second, cadastro, surfaces, errors: sync });

      const services = await mockServices(tx, osId);
      expect(services).toHaveLength(1);
      expect(services[0]?.items.map(itemShape)).toEqual([
        {
          description: "new",
          kind: "oleo",
          quantity: 2,
          unitAmount: 3,
          lineAmount: 6,
          oilViscosity: null,
        },
      ]);
    }));

  it("stores performedAt null when the mock OS date is null", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { osId } = await pullAndImport(tx, { order: (order) => ({ ...order, performedAt: null }) });

      expect((await mockServices(tx, osId))[0]?.performedAt).toBeNull();
    }));

});
