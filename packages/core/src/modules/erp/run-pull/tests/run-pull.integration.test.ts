/**
 * Test design (testing-strategy)
 *
 * Setup: runOmiePull with the real stores `runPull` builds —
 * `createCadastroImportStore` (customers contract), `createSyncRunRecorder`
 * (erp contract) and `createSurfaceImportStore` (this slice: services and quotes
 * contracts) — inside a rolled-back transaction, driven by `createMockOmie` from
 * the kernel's `erp-mock`. No fetch.
 *
 * Roles: every store call runs in its owner's `db.tx` — `module_customers`,
 * `module_services`, `module_quotes` and `module_erp` — so a write to a table
 * the role does not own fails here. Moved from `apps/worker/src/omie/run-pull.test.ts`
 * (adopt-modular-vertical-slices 3A.3), 7 cases, assertions unchanged. Every
 * Omie id a run imports is unique to the test (`scopedMockOmie`, the #163
 * follow-up): with the dataset's own ids, every surface test and the demo seed
 * upserted the same rows and waited on each other's locks, and the catalog ids
 * also deadlocked against the quotes suites. The "mock-backed job" case passes no
 * `source`, so `input.source ?? createMockOmie(env)` — the path production
 * takes — stays covered; it alone keeps the dataset's ids, and renames only the
 * catalog products, in the import store.
 *
 * Fake-only assertions surfaced (two):
 *
 *  1. Every inspector this file asserted through was a stub on the real adapters.
 *     `createMemorySyncRunStore` answered `runs()` and `errors()` from its own
 *     arrays and `createMemorySurfaceImportStore` answered `listImportedServices()`
 *     and `listImportedCatalogIds()` from its own maps; the Prisma stores returned
 *     `[]` from all four. The two sync-run inspectors have since been deleted
 *     outright (#106); the import ones remain. So assertions such as `sync.runs()[0].status === "completed"`
 *     and `importStore.listImportedServices()).toHaveLength(1)` would have passed
 *     unchanged against a store that persisted nothing whatsoever. They now read
 *     `syncExecution`, `integrationError` and `service` back through the
 *     transaction.
 *
 *  2. `sync.runs()` starting empty was a property of a fresh fake. A worktree
 *     database already holds sync executions, so "no run was recorded" is now a
 *     delta over the run ids present before the call (D9), which is also what
 *     makes it hold on CI's freshly migrated, unseeded database.
 *
 * The duplicate it below asserted only that a row was present, never that it
 * was not repeated, because `importMockSurfaces` guarded its duplicate record
 * with `input.errors.errors()` and the real sync-run store answered `[]`, so a
 * second mock pull recorded the pair again. That was GitHub issue #106, found
 * here and since fixed: the guard asks `hasRecordedError` and both inspectors
 * are deleted. The count is pinned exactly now, and re-import is covered in
 * `import-surfaces.test.ts`, which is where the guard itself is exercised.
 *
 * Oracle: omie-mock — mock opt-in runs without credentials; neither flag
 *   stays inactive. customer-services — first import creates OS, second
 *   creates none. omie-sync — duplicate pair unmerged; watermark advances
 *   only from completed runs; failed run records a code; completed run
 *   records totals. apply-notes — client pull does not invent services;
 *   importer uses upsertServiceByOmieId only.
 *
 * Axes
 *   A1 access — inactive / OMIE_MOCK=1
 *   A2 run — first full / second full / incremental after complete / incremental after failReads
 *   A3 OS list — default dataset / empty
 *
 * Outputs: O1 inactive no customers; O2 mock customers+OS; O3 second run adds no
 *   service row; O4 failed code omie_pull_failed; O5 previous windowTo;
 *   O6 completed totals read/written; O7 fetch unused
 *
 * Sampled-cell
 *   neither flag                         | A1 inactive | O1 O7 | customer invented
 *   OMIE_MOCK=1                          | A1 mock     | O2 O6 O7 | fetch
 *   second mock full                     | A2 second   | O3 | second OS row
 *   empty OS after pull                  | A3 empty    | 0 new services | os-mock-1 invented
 *   failReads incremental                | A2 fail     | O4 O5 | windowTo of failed run
 *
 * Decision / branch map (run-pull.ts)
 *   access inactive                      T neither it; F mock its
 *   access credentials                   not sampled — HTTP; create-adapter.test.ts
 *   access mock                          T mock its; F inactive
 *   importMockSurfaces throw             T not sampled (ports don't throw); F happy mock
 *
 * Out of scope: live HTTP; `runPull`'s composition and its
 *   `reconcileVehicleReturns` call, which is not part of `runOmiePull` — the
 *   roles file covers `runPull`.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { scopedMockOmie } from "./scoped-mock.js";
import type { OmieSurfaceImportStore } from "../../contracts/import-surfaces-store.js";
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
import { createSurfaceImportStore, runOmiePull } from "../index.js";

/** The default test transaction: with scoped ids no case waits on another's rows. */
function inSurfaceTransaction<T>(client: PrismaClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return withTestTransaction(client, fn);
}

/** A pull whose test created no unlinked customer matches nothing: production's database-wide pass, scoped to none. */
const NO_CANDIDATES = { customerIds: [] };

const MOCK_ENV = { OMIE_MOCK: "1" };
/** The one OS id the mock dataset lists. */
const MOCK_OS_ID = "os-mock-1";
/** The catalog ids the mock dataset lists; each test renames them (see header). */
const MOCK_CATALOG_IDS = ["cat-motul-8100-5w30", "cat-tecfil-pel108", "cat-tecfil-gi50-7"];

/** All three real stores, bound to the test's transaction. */
function stores(tx: DbClient) {
  const db = createDb(tx, runInTransactionOnTx(tx));
  return {
    store: createCadastroImportStore(db, {}),
    sync: createSyncRunRecorder(db),
    importStore: createSurfaceImportStore(db),
  };
}

/** Renames an id to one unique to this test. */
function catalogIdsFor(): (omieId: string) => string {
  const prefix = `t${randomUUID().replace(/-/g, "").slice(0, 8)}-`;
  return (omieId) => `${prefix}${omieId}`;
}

/** The import store with each catalog product renamed to this test's ids on the way in. */
function renamingCatalog(
  importStore: OmieSurfaceImportStore,
  id: (omieId: string) => string = catalogIdsFor(),
): OmieSurfaceImportStore {
  return {
    ...importStore,
    upsertCatalogProduct: (product) =>
      importStore.upsertCatalogProduct({ ...product, omieId: id(product.omieId) }),
  };
}

/** Run ids present before the call, so "which runs did this cause" is a delta. */
async function runIds(tx: DbClient): Promise<string[]> {
  const rows = await tx.syncExecution.findMany({ select: { id: true } });
  return rows.map((row) => row.id);
}

/** The sync executions created since `before`, oldest first. */
function runsSince(tx: DbClient, before: string[]) {
  return tx.syncExecution.findMany({
    where: { id: { notIn: before } },
    orderBy: { createdAt: "asc" },
  });
}

/** Totals come back as JSON; this is their shape. */
function totalsOf(row: { totals: unknown }) {
  return row.totals as { read: number; written: number; errors: number };
}

/** The service rows the mock import owns, by its one OS id. */
function mockServices(tx: DbClient, osId: string = MOCK_OS_ID) {
  return tx.service.findMany({ where: { omieId: osId } });
}

async function withFetchGuard<T>(run: () => Promise<T>): Promise<T> {
  const fetchSpy = vi.fn();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;
  try {
    const result = await run();
    expect(fetchSpy).not.toHaveBeenCalled();
    return result;
  } finally {
    globalThis.fetch = previous;
  }
}

describeWithDatabase("runOmiePull", () => {
  const db = () => prisma as PrismaClient;

  it("no-ops when neither credentials nor the mock opt-in are set", () =>
    inSurfaceTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        await seedUnit(tx);
        const { store, sync, importStore } = stores(tx);
        const before = await runIds(tx);
        const servicesBefore = (await mockServices(tx)).length;

        const access = await runOmiePull({ matchScope: NO_CANDIDATES, mode: "full", env: {}, store, sync, importStore });

        expect(access).toBe("inactive");
        expect(await store.findCustomerByOmieId("omie-mock-linked-unseeded")).toBeNull();
        expect(await runsSince(tx, before)).toHaveLength(0);
        expect(await mockServices(tx)).toHaveLength(servicesBefore);
      }),
    ));

  it("runs the mock-backed job without credentials and records completed totals", () =>
    inSurfaceTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        await seedUnit(tx);
        const { store, sync, importStore } = stores(tx);
        const before = await runIds(tx);
        const now = new Date("2026-09-01T15:00:00.000Z");

        // No `source`: the production path, where the pull builds the mock from
        // `env` itself. The catalog is renamed on its way into the store instead.
        const access = await runOmiePull({ matchScope: NO_CANDIDATES,
          mode: "full",
          env: MOCK_ENV,
          store,
          sync,
          importStore: renamingCatalog(importStore),
          now,
        });

        expect(access).toBe("mock");
        expect(await store.findCustomerByOmieId("omie-mock-linked")).not.toBeNull();
        const services = await mockServices(tx);
        expect(services).toHaveLength(1);
        expect(services[0]?.origin).toBe("omie");
        expect("create" in importStore).toBe(false);
        expect("createService" in store).toBe(false);
        const created = await runsSince(tx, before);
        expect(created).toHaveLength(1);
        expect(created[0]?.status).toBe("completed");
        expect(created[0]?.mode).toBe("full");
        expect(created[0]?.windowTo?.toISOString()).toBe(now.toISOString());
        expect(totalsOf(created[0]!).read).toBeGreaterThan(0);
        expect(totalsOf(created[0]!).written).toBeGreaterThan(0);
      }),
    ));

  it("creates no second service row on a second mock run", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { store, sync, importStore } = stores(tx);
      const { source, id } = scopedMockOmie();

      await runOmiePull({ matchScope: NO_CANDIDATES, mode: "full", env: MOCK_ENV, store, sync, importStore, source });
      const afterFirst = await mockServices(tx, id(MOCK_OS_ID));
      await runOmiePull({ matchScope: NO_CANDIDATES, mode: "full", env: MOCK_ENV, store, sync, importStore, source });

      expect(afterFirst).toHaveLength(1);
      expect(await mockServices(tx, id(MOCK_OS_ID))).toHaveLength(1);
      expect((await mockServices(tx, id(MOCK_OS_ID)))[0]?.id).toBe(afterFirst[0]?.id);
      // The mock's three catalog rows exist afterwards, under this test's ids.
      const ids = MOCK_CATALOG_IDS.map(id);
      const catalog = await tx.catalogItem.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      expect(catalog.map((row) => row.id).sort()).toEqual([...ids].sort());
    }));

  it("creates no service when the mock lists zero OS", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { store, sync, importStore } = stores(tx);
      const { source, id } = scopedMockOmie();
      source.serviceOrders = {
        async listByClient() {
          return [];
        },
      };

      await runOmiePull({ matchScope: NO_CANDIDATES, mode: "full", env: MOCK_ENV, store, sync, importStore, source });

      expect(await mockServices(tx, id(MOCK_OS_ID))).toHaveLength(0);
      // Control: the pull did run, and imported the client the OS would have hung off.
      expect(await store.findCustomerByOmieId(id("omie-mock-linked"))).not.toBeNull();
    }));

  it("surfaces duplicate candidates without merging either customer", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { store, sync, importStore } = stores(tx);
      const { source, id } = scopedMockOmie();
      const correlationId = `${id("omie-mock-dup-a")}:${id("omie-mock-dup-b")}`;
      expect(
        await tx.integrationError.count({ where: { code: "omie_duplicate_candidate", correlationId } }),
      ).toBe(0);

      await runOmiePull({ matchScope: NO_CANDIDATES,
        mode: "full",
        env: MOCK_ENV,
        store,
        sync,
        importStore,
        source,
      });

      const left = await store.findCustomerByOmieId(id("omie-mock-dup-a"));
      const right = await store.findCustomerByOmieId(id("omie-mock-dup-b"));
      expect(left?.mergedIntoId).toBeNull();
      expect(right?.mergedIntoId).toBeNull();
      expect(
        await tx.integrationError.count({ where: { code: "omie_duplicate_candidate", correlationId } }),
      ).toBe(1);
    }));

  it("leaves the watermark intact and records a code when incremental reads fail", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { store, sync, importStore } = stores(tx);
      const { source } = scopedMockOmie();
      const firstNow = new Date("2026-09-01T15:00:00.000Z");
      const before = await runIds(tx);

      await runOmiePull({ matchScope: NO_CANDIDATES,
        mode: "full",
        env: MOCK_ENV,
        store,
        sync,
        importStore,
        source,
        now: firstNow,
      });
      source.failReads();

      await expect(
        runOmiePull({ matchScope: NO_CANDIDATES,
          mode: "incremental",
          env: MOCK_ENV,
          store,
          sync,
          importStore,
          source,
          now: new Date("2026-09-01T16:00:00.000Z"),
        }),
      ).rejects.toThrow("omie_unavailable");

      const completed = await sync.latestCompleted("cliente");
      expect(completed?.windowTo).toBe(firstNow.toISOString());
      const created = await runsSince(tx, before);
      const failed = created.find((row) => row.status === "failed");
      expect(failed).toBeDefined();
      expect(failed?.windowTo).toBeNull();
      expect(
        await tx.integrationError.count({
          where: { code: "omie_pull_failed", correlationId: failed!.id },
        }),
      ).toBe(1);
    }));

  it("asks the second incremental run for alterations after the completed watermark", () =>
    inSurfaceTransaction(db(), async (tx) => {
      await seedUnit(tx);
      const { store, sync, importStore } = stores(tx);
      const { source } = scopedMockOmie();
      const firstNow = new Date("2026-09-01T15:00:00.000Z");
      const filters: Array<{ alteredAfter?: string } | undefined> = [];
      const originalList = source.clients.listPage.bind(source.clients);
      source.clients.listPage = async (page, filter) => {
        filters.push(filter);
        return originalList(page, filter);
      };

      await runOmiePull({ matchScope: NO_CANDIDATES,
        mode: "full",
        env: MOCK_ENV,
        store,
        sync,
        importStore,
        source,
        now: firstNow,
      });
      await runOmiePull({ matchScope: NO_CANDIDATES,
        mode: "incremental",
        env: MOCK_ENV,
        store,
        sync,
        importStore,
        source,
        now: new Date("2026-09-01T16:00:00.000Z"),
      });

      const incrementalFilters = filters.filter((filter) => filter?.alteredAfter);
      expect(incrementalFilters[0]?.alteredAfter).toBe(firstNow.toISOString());
    }));
});
