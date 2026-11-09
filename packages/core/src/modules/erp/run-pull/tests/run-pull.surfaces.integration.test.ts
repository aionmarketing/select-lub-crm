/**
 * Test design (testing-strategy)
 *
 * Exercises erp's `run-pull/import-surfaces.ts` (`importMockSurfaces`),
 * its `pull` module (`pullOmieClients`) and its `mock` source (`createMockOmie`,
 * `mockOmieDataset`) against the real stores this worker owns:
 * `createPrismaSurfaceImportStore` (apps/worker/src/omie/import-prisma.ts) and
 * `createPrismaPullCadastroStore` + `createPrismaSyncRunStore`
 * (apps/worker/src/omie/prisma.ts). Relocated from
 * `packages/omie/src/import-surfaces.test.ts`: `packages/db` depends on
 * `packages/omie`, so the Prisma adapters cannot live in the Omie package (D6).
 *
 * Setup: all three real stores on a rolled-back transaction + createMockOmie.
 * pullOmieClients then importMockSurfaces. No fetch.
 *
 * Fake-only assertions surfaced (three, and this file had the most of any in the
 * stream):
 *
 *  1. EVERY assertion in the original file read through
 *     `listImportedServices()`, `listImportedCatalogIds()`,
 *     `listImportedLubricantIds()` or `listImportedFilterIds()`. All four are
 *     `return []` on `createPrismaSurfaceImportStore` — they exist for the fake's
 *     benefit and the real adapter does not maintain them. So the entire file
 *     would have passed against an importer that wrote nothing to Postgres at
 *     all. Assertions now read `service`, `serviceItem`, `catalogItem`,
 *     `catalogLubricant` and `catalogFilter` back through the transaction.
 *
 *  2. The fake began empty, so "first import creates" was the default. A seeded
 *     database already contains every mock identifier — `os-mock-1`, the three
 *     catalog ids, the four mock customers and `veh-omie-mock-1` — so there the
 *     first import is always a re-import and `importMockSurfaces` returns
 *     `created: 0`; against an empty one the same code returns `created > 0`.
 *     Which of the two you get is decided by how vitest was started, not by CI
 *     versus local: the ROOT config's `globalSetup`
 *     (`packages/core/src/kernel/prisma/live-seed-once.ts`) migrates and seeds once before any
 *     project runs, so `pnpm test` and CI's `pnpm test:coverage` are seeded,
 *     while a package-scoped `pnpm --filter … test` never loads that config and
 *     sees whatever the database already held. And that setup is best-effort by
 *     design — it warns and continues rather than failing the run — so even the
 *     root invocation is seeded usually, not always. No assertion here may
 *     depend on any of that, so every one keyed on the created/updated verb was
 *     replaced by an end-state assertion, which holds in all of those states
 *     (D9). Verified by running this file on both a seeded and a freshly
 *     migrated, provably empty database.
 *
 *  3. The catalog assertions were whole-table equality
 *     (`listImportedCatalogIds()).toEqual([three ids])`). The real `catalog_item`
 *     table holds the shop's own products beside the mock's, so the id lists are
 *     now scoped to the ids under test.
 *
 *  4. `ServiceItem.unitAmount` and `.lineAmount` are `Decimal(10, 2)` columns, so
 *     Prisma returns Decimal instances where the fake stored JS numbers: the
 *     item assertions failed on `6` vs `"6"`. A consumer that adds these up gets
 *     string concatenation on the real row and arithmetic on the fake, and no
 *     test could see the difference. They are compared through `itemShape`, which
 *     converts explicitly rather than hiding it behind a loose matcher.
 *
 *  5. The three "vehicleId ends up null" cells failed against the seeded database
 *     for a real reason: `upsertServiceByOmieId` only writes `vehicleId` on the
 *     update path when it resolves one (`vehicleId ? { ...data, vehicleId } : data`),
 *     so a re-import that cannot resolve deliberately KEEPS the existing link —
 *     the behaviour the "keeps an existing link" it asserts. On the fake those
 *     cells were always creates, so they conflated "import produced no link" with
 *     "import did not clear one". They now pass an `osId` no seed holds, so the
 *     create path is what runs, and the two behaviours are sampled separately.
 *
 * GitHub issue #106, found here and now fixed. `importMockSurfaces` used to
 * guard its duplicate record with `input.errors.errors()`, a whole-table
 * snapshot that `createPrismaSyncRunStore` answered `[]` to, so the guard never
 * fired and each mock pull recorded the pair again (0 → 1 → 2 across two
 * imports, measured). The deleted in-memory store returned everything recorded,
 * which is why the dedupe looked implemented. The guard now asks the store the
 * narrow question, `hasRecordedError({ code, correlationId })`, and both
 * inspectors are gone so nothing can be built on them again.
 *
 * Three its cover it. The pair is surfaced with both customers unmerged, which
 * is the requirement and was true either way. The re-import records nothing
 * further, which is the assertion that was pinned to the defect and has now
 * flipped. And the port itself is pinned in both directions, because a guard
 * that over-matches would suppress a different pair just as silently as the
 * old one failed to suppress this one.
 *
 * Oracle: customer-services — mock import creates Omie-origin service with omieId;
 *   re-import does not duplicate; import is the only creator (no generic create).
 *   omie-sync — duplicate pair surfaced, no merge pointer, neither row deleted.
 *   omie-mock — second run creates no duplicate CRM rows; no network; a mock catalog
 *   product may carry filter fields, and importing it writes exactly one filter-detail
 *   (tecfil-filter-pricing task 2.4).
 *   apply-notes — client pull still invents no services; importer writes only
 *   identifier-keyed rows the mock listed.
 *
 * Axes
 *   A1 OS list — one mock OS / empty list / listed ids only
 *   A2 run — first import / second import
 *   A3 write path — upsertByOmieId vs ServicesStore.create vs CadastroStore.createService
 *   A4 duplicates — pair present / merge pointer
 *   A5 products / vehicle ids — first / second
 *   A6 product detail — oil (viscosity, fixture Motul) / filter (filterType, the two
 *      Tecfil mock products) / neither (a plain filter with no detail fields) / both
 *      (rejected, writes neither detail)
 *   A7 order names a vehicle — vehicleOmieId set and matching / set and unknown /
 *      null. Yes/no-plus-unknown domain, no BVA row.
 *   A8 vehicle exists when the OS is imported — yes (import order) / no (service
 *      imported first, vehicle appears later)
 *
 * Outputs: O1 one service omieId os-mock-1 origin omie; O2 no service row;
 *   O3 catalog rows (Motul + the two Tecfil mock products); O4 vehicle omieId
 *   veh-omie-mock-1; O5 omie_duplicate_candidate + mergedIntoId null; O6 no fetch;
 *   O7 lubricant-detail rows (subset of O3); O10 filter-detail rows (subset of O3,
 *   disjoint from O7);
 *   O8 service.vehicleId = the CRM id of the vehicle carrying veh-omie-mock-1;
 *   O9 service.vehicleId null
 *
 * Sampled-cell
 *   first import after client pull     | A1 one A2 first  | O1 O3 O4 O5 | duplicate row / create()
 *   second import                      | A2 second        | same rows + O7 O10 | second service row
 *   seed then import                   | A2 after seed    | no new rows | extra OS / catalog / vehicle
 *   mock lists zero OS                 | A1 empty         | O2          | os-mock-1 row
 *   fixture Motul imports with a child | A6 oil           | O3 O7       | no child / productLine kept
 *   Tecfil mocks import with a child   | A6 filter        | O3 O10      | child written as lubricant
 *   both-fields product is rejected    | A6 both          | O3, no O7/O10 | a detail written anyway
 *   plain product has no detail        | A6 neither       | O3, no O7/O10 | a detail invented
 *   OS names a known vehicle           | A7 match A8 yes  | O8          | vehicleId null / another vehicle's id
 *   OS names no vehicle                | A7 null          | O9          | any vehicleId set
 *   OS names an unknown vehicle        | A7 unknown       | O9          | a vehicle invented for it
 *   vehicle arrives after the service  | A8 no, then yes  | O9 then O8  | link never resolving
 *   re-import cannot resolve           | A8 yes, then no  | O8 kept     | link cleared to null
 *   cadastro has no createService      | A3               | —           | "createService" in store
 *   import store has no create         | A3               | —           | "create" in surfaces
 *
 * Decision / branch map (import-surfaces.ts / import-store.ts)
 *   client.omieId === "" skip           T pull empty-id (pull.test.ts); F listed clients
 *   upsertService skipped (no customer) T not sampled here — pull runs first; F after pull
 *   existing service omieId             T second import; F first (CI only, see 2 above)
 *   vehicle match by omieId / plate     T known-vehicle / plate its; F unknown-vehicle it
 *   duplicate already recorded          guard is dead against the real store (defect above)
 *   product is lubricant-only           T fixture Motul it; F other detail its
 *   product is filter-only              T Tecfil mock its; F other detail its
 *   product carries both details        T both-fields it; F single-detail its
 *   order.vehicleOmieId truthy          T known-vehicle it; F no-vehicle it
 *   vehicle found for that customer     T known-vehicle it; F unknown-vehicle it
 *   update re-resolves (?? existing)    T vehicle-arrives-later it; F re-import-cannot-resolve it
 *
 * Out of scope: live HTTP Omie; merge execution #5.
 *   oil-quote empty-classification match is already in apps/api oil-quote/match.test.ts
 *   ("offers an empty-classification lubricant on viscosity alone") — this file
 *   samples the imported TIDSCI oil (viscosity, empty classification) getting a
 *   lubricant-detail row.
 *
 * A9 OS items — two lines / none / replaced on re-import / performedAt null
 * A10 order.plate — matches customer vehicle / unknown plate
 * A11 catalog downgrade — had viscosity, returns without; never had one
 * O11 two items; O12 empty items; O13 later list; O14 performedAt null;
 * O15 vehicleId from plate; O16 lubricant row dropped
 *
 * MOVED (adopt-modular-vertical-slices 3A.3): from `apps/worker/src/omie/import-surfaces.test.ts`,
 * 18 cases, split by topic under the line cap: the 9 service-order and vehicle-link
 * cases here, the 4 line-item cases in `run-pull.surfaces-items.integration.test.ts`,
 * and the re-import, seeded-identifier and duplicate-pair five in
 * `run-pull.surfaces-reimport.integration.test.ts`. The stores are now the ones
 * `runPull` builds, each call in its owner's `db.tx` (`module_customers`,
 * `module_services`, `module_quotes`, `module_erp`). Every mock source's catalog
 * products carry ids unique to the test: in `core` this file runs in parallel
 * with the quotes suites, which seed the same catalog ids, and two writers taking
 * those row locks in different orders deadlock. Assertions are unchanged but for
 * those ids.
 *
 * MOVED OUT (adopt-modular-vertical-slices 2B.2): the six catalog-only cases — the
 * fixture Motul lubricant, the Tecfil filters, the product carrying both kinds, the
 * product with no detail, the downgrade that drops a lubricant row, and the TIDSCI oil
 * with an empty classification — now live in the quotes module's
 * `import-catalog-from-erp` slice tests, where they run under the `quotes` role. That
 * takes axes A6 and A11 and outputs O3, O7, O10 and O16 with them. The catalog is now
 * written through the quotes contract `upsertCatalogProduct`, which import-prisma
 * delegates to. The re-import and seeded-identifier cases stay here: they assert
 * service and vehicle-identifier rows as well as catalog ones. 24 cases → 18 here + 6
 * moved.
 */
import { randomUUID } from "node:crypto";
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

/** An OS id no seed holds, so the import takes its create path. */
function freshOsId(): string {
  return `os-fresh-${randomUUID().slice(0, 8)}`;
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
  return { cadastro, sync, surfaces, imported, fetchSpy, id, osId };
}

describeWithDatabase("importMockSurfaces", () => {
  const db = () => prisma as PrismaClient;

  it("keeps exactly one Omie-origin service for the listed OS id and does not invent extras", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { cadastro, surfaces, fetchSpy, osId } = await pullAndImport(tx);

      const services = await mockServices(tx, osId);
      expect(services).toHaveLength(1);
      expect(services[0]?.omieId).toBe(osId);
      expect(services[0]?.origin).toBe("omie");
      expect("createService" in cadastro).toBe(false);
      expect("create" in surfaces).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    }));

  it("links the imported service to the vehicle its OS names", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { cadastro, id, osId } = await pullAndImport(tx);

      const service = (await mockServices(tx, osId))[0];
      const vehicles = await cadastro.listVehicles(service?.customerId ?? "");
      const named = vehicles.find((vehicle) => vehicle.omieId === id("veh-omie-mock-1"));

      expect(named).toBeDefined();
      expect(service?.vehicleId).toBe(named?.id);
    }));

  it("leaves the service unlinked when its OS names no vehicle", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const osId = freshOsId();
      await pullAndImport(tx, {
        osId,
        order: (order) => ({ ...order, vehicleOmieId: null, plate: "" }),
      });

      const services = await mockServices(tx, osId);
      expect(services).toHaveLength(1);
      expect(services[0]?.vehicleId).toBeNull();
    }));

  it("leaves the service unlinked when its OS names a vehicle the mock never listed", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const osId = freshOsId();
      const { cadastro } = await pullAndImport(tx, {
        osId,
        order: (order) => ({ ...order, vehicleOmieId: "veh-omie-does-not-exist", plate: "" }),
      });

      const service = (await mockServices(tx, osId))[0];
      const vehicles = await cadastro.listVehicles(service?.customerId ?? "");

      expect(service?.vehicleId).toBeNull();
      // The unknown id must not have caused a vehicle to be invented for it.
      expect(vehicles.some((vehicle) => vehicle.omieId === "veh-omie-does-not-exist")).toBe(false);
    }));

  it("re-resolves the link on a later import when the vehicle was missing the first time", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);
      // A vehicle identifier of this test's own, so the cell is built by adding
      // a row rather than by deleting the seeded `veh-omie-mock-1` — base rows
      // are read, never written, by this suite.
      const osId = freshOsId();
      const vehicleOmieId = `veh-late-${randomUUID().slice(0, 8)}`;
      const named = (source: MockOmieSource) => {
        const inner = source.serviceOrders;
        source.serviceOrders = {
          async listByClient(clientOmieId: string) {
            return (await inner.listByClient(clientOmieId)).map((order) => ({
              ...order,
              omieId: osId,
              vehicleOmieId,
              plate: "",
            }));
          },
        };
        return source;
      };

      // First run: the OS names a vehicle the identifier surface does not list,
      // so the service imports unlinked.
      // One scope for both imports: the second re-imports the first's OS and client.
      const scope = scopedMockOmie();
      const withoutVehicles = named(scope.source);
      withoutVehicles.vehicleIds = {
        async listVehicleIds() {
          return [];
        },
      };
      await pullOmieClients({ matchScope: NO_CANDIDATES,
        mode: "full",
        store: cadastro,
        adapter: withoutVehicles.clients,
        sync,
      });
      await importMockSurfaces({ source: withoutVehicles, cadastro, surfaces, errors: sync });
      const first = await mockServices(tx, osId);
      expect(first).toHaveLength(1);
      expect(first[0]?.vehicleId).toBeNull();

      // Second run: the surface now lists that identifier, so the importer
      // creates the vehicle and the same OS finds it.
      const withVehicles = named(scope.another());
      withVehicles.vehicleIds = {
        async listVehicleIds() {
          return [{ vehicleOmieId, clientOmieId: scope.id("omie-mock-linked"), plate: "LATE1A23" }];
        },
      };
      await importMockSurfaces({ source: withVehicles, cadastro, surfaces, errors: sync });

      const service = (await mockServices(tx, osId))[0];
      const vehicles = await cadastro.listVehicles(service?.customerId ?? "");
      const arrived = vehicles.find((vehicle) => vehicle.omieId === vehicleOmieId);
      expect(arrived).toBeDefined();
      expect(service?.vehicleId).toBe(arrived?.id);
    }));

  it("keeps an existing link when a later import cannot resolve the vehicle", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { cadastro, sync, surfaces } = stores(tx);

      const scope = scopedMockOmie();
      const osId = scope.id(MOCK_OS_ID);
      const linked = scope.source;
      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store: cadastro, adapter: linked.clients, sync });
      await importMockSurfaces({ source: linked, cadastro, surfaces, errors: sync });
      const before = (await mockServices(tx, osId))[0]?.vehicleId;
      expect(before).not.toBeNull();

      // The same OS arrives again naming no vehicle. A re-import that cannot
      // resolve must not orphan a service that already had a link.
      const unnamed = scope.another();
      unnamed.serviceOrders = {
        async listByClient(clientOmieId: string) {
          const rows = await linked.serviceOrders.listByClient(clientOmieId);
          return rows.map((row) => ({ ...row, vehicleOmieId: null, plate: "" }));
        },
      };
      await importMockSurfaces({ source: unnamed, cadastro, surfaces, errors: sync });

      expect((await mockServices(tx, osId))[0]?.vehicleId).toBe(before);
    }));

  it("does not create a service when the mock lists zero OS for pulled clients", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { cadastro, id } = await pullAndImport(tx, { emptyOs: true });

      // No OS was listed, so no service row for this test's OS id may appear.
      expect(await mockServices(tx, id(MOCK_OS_ID))).toHaveLength(0);
      // Control: the pull ran and imported the client the OS would have hung off.
      expect(await cadastro.findCustomerByOmieId(id("omie-mock-linked"))).not.toBeNull();
    }));

  it("sets vehicleId from a matching customer plate when vehicleOmieId is absent", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const { cadastro, osId } = await pullAndImport(tx, {
        order: (order) => ({ ...order, vehicleOmieId: null, plate: "ABC1D23" }),
      });

      const service = (await mockServices(tx, osId))[0];
      const vehicles = await cadastro.listVehicles(service?.customerId ?? "");
      expect(service?.vehicleId).toBe(vehicles.find((vehicle) => vehicle.plate === "ABC1D23")?.id);
    }));

  it("leaves vehicleId null when the order plate is unknown to the customer", () =>
    inSurfaceTransaction(db(), async (tx) => {
      const osId = freshOsId();
      await pullAndImport(tx, {
        osId,
        order: (order) => ({ ...order, vehicleOmieId: null, plate: "ZZZ9Z99" }),
      });

      expect((await mockServices(tx, osId))[0]?.vehicleId).toBeNull();
    }));
});
