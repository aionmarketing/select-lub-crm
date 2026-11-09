/**
 * The ERP pull: CRM ← ERP, clients first, then (mock only) service orders,
 * catalog, vehicle ids and duplicate candidates.
 *
 * Moved from `apps/worker/src/omie/run-pull.ts`. `runOmiePull` is unchanged.
 * `runPull` replaces `runOmiePullJob(prisma, …)`: instead of building every store
 * over the raw client, it builds each from the contract of the module that owns
 * the tables, so each write runs under that module's role —
 *
 * - cadastro: `customers/contracts/import-from-erp` (STUB until 4B),
 * - service orders: `services/contracts/import-from-erp`,
 * - catalog: `quotes/contracts/upsert-catalog-product`,
 * - runs and errors: this module's `record-sync-run`.
 *
 * Every store operation is its own transaction; none spans an ERP call (W2-C12).
 * The worker still drives this through `startWorker`'s `runOmiePull` option and
 * its `WORKER_OMIE_PULL` / `WORKER_OMIE_POLL` flags; it is not a registered job.
 */
import { createHttpOmieAdapter, createMockOmie, resolveOmieAccess, type MockOmieSource } from "../../../kernel/clients/erp-mock.js";
import { importMockSurfaces } from "./import-surfaces.js";
import { pullOmieClients } from "./pull.js";
import type { CadastroStore, MatchCandidateScope } from "../../customers/contracts/cadastro-store/port.js";
import type { OmieSurfaceImportStore } from "../contracts/import-surfaces-store.js";
import type { SyncRunStore } from "../contracts/sync-run-store.js";
import type { Db } from "../../../kernel/db.js";
import { createCadastroImportStore } from "../../customers/contracts/import-from-erp.js";
import { upsertCatalogProduct } from "../../quotes/contracts/upsert-catalog-product.js";
import { createServiceImportStore } from "../../services/contracts/import-from-erp.js";
import { reconcileVehicleReturnsAfterImport } from "../../services/contracts/reconcile-vehicle-returns.js";
import { createSyncRunRecorder } from "../contracts/record-sync-run.js";

/**
 * Runs one Omie pull against injected stores, selecting credentials / mock / inactive from env.
 *
 * Inactive no-ops. Credentials run the client pull over HTTP. Mock runs the client pull
 * plus identifier-keyed OS, catalog, vehicle-id, and duplicate-candidate import.
 *
 * @param input.mode - `"full"` or `"incremental"` passed to `pullOmieClients`.
 * @param input.env - Environment map; defaults to `process.env`.
 * @param input.store - Cadastro persistence.
 * @param input.sync - Run and error recorder.
 * @param input.importStore - Identifier-keyed OS/catalog upserts used only for mock.
 * @param input.now - Clock override for the watermark.
 * @param input.source - Optional mock source (tests inject `failReads` / empty OS).
 * @param input.matchScope - Restricts the match pass to these customers. The worker
 *   omits it, so production matches database-wide; tests pass their own.
 * @returns The access kind that ran, or `"inactive"` when the job no-opped.
 */
export async function runOmiePull(input: {
  mode: "full" | "incremental";
  env?: NodeJS.ProcessEnv;
  store: CadastroStore;
  sync: SyncRunStore;
  importStore: OmieSurfaceImportStore;
  now?: Date;
  source?: MockOmieSource;
  matchScope?: MatchCandidateScope;
  log?: (message: string) => void;
}): Promise<"inactive" | "credentials" | "mock"> {
  const env = input.env ?? process.env;
  const access = resolveOmieAccess(env);
  if (access === "inactive") {
    return "inactive";
  }
  if (access === "credentials") {
    const adapter = createHttpOmieAdapter({
      appKey: env.OMIE_APP_KEY as string,
      appSecret: env.OMIE_APP_SECRET as string,
      errorSink: input.sync });
    await pullOmieClients({
      mode: input.mode,
      store: input.store,
      adapter,
      sync: input.sync,
      now: input.now,
      matchScope: input.matchScope,
      ...(input.log ? { log: input.log } : {}) });
    return "credentials";
  }

  const source = input.source ?? createMockOmie(env);
  const pulled = await pullOmieClients({
    mode: input.mode,
    store: input.store,
    adapter: source.clients,
    sync: input.sync,
    now: input.now,
    matchScope: input.matchScope,
    ...(input.log ? { log: input.log } : {}) });
  let imported: { read: number; written: number; created: number; errors: number };
  try {
    imported = await importMockSurfaces({
      source,
      cadastro: input.store,
      surfaces: input.importStore,
      errors: input.sync });
  } catch (error: unknown) {
    await input.sync.record({
      operation: "importMockSurfaces",
      code: "omie_import_failed",
      message: error instanceof Error ? error.message : "unknown",
      retryable: true,
      attemptCount: 1,
      correlationId: pulled.id });
    imported = { read: 0, written: 0, created: 0, errors: 1 };
  }
  await input.sync.updateRun(pulled.id, {
    totals: {
      read: pulled.totals.read + imported.read,
      written: pulled.totals.written + imported.written,
      errors: pulled.totals.errors + imported.errors } });
  return "mock";
}

/**
 * The surface import store the pull hands `importMockSurfaces`: service orders
 * through `services`, catalog products through `quotes`.
 *
 * The catalog stays driven by the pull, product by product, and quotes'
 * `import-catalog-from-erp` job stays unregistered (W2-C10, decided in 3A): the
 * pull counts catalog reads and writes into its run's totals and records their
 * errors against the run id, which a separate job would lose.
 *
 * @param db - The database handle.
 * @returns An {@link OmieSurfaceImportStore} whose writes run under each owner's role.
 */
export function createSurfaceImportStore(db: Db): OmieSurfaceImportStore {
  return {
    ...createServiceImportStore(db),
    upsertCatalogProduct: (product) => upsertCatalogProduct(db, product),
    listImportedCatalogIds() {
      return [];
    },
    listImportedLubricantIds() {
      return [];
    },
    listImportedFilterIds() {
      return [];
    },
  };
}

/**
 * Runs a full or incremental ERP pull when credentials or `OMIE_MOCK=1` are configured.
 *
 * No-ops when neither credentials nor the mock opt-in are set.
 *
 * @param db - The database handle; the composition root builds it from the Prisma singleton.
 * @param mode - Pull mode passed to `pullOmieClients`; defaults to `"full"`.
 * @param env - Environment map; defaults to `process.env`.
 * @param source - The mock source; production omits it and the pull builds one
 *   from `env`. Tests pass one whose catalog ids are their own.
 * @param matchScope - Restricts the match pass to these customers. The worker
 *   (`apps/worker/src/index.ts`) calls `runPull(db, mode, process.env, undefined,
 *   undefined, log)` — no scope, and its own log — so
 *   production matches database-wide; tests pass their own customers.
 * @param log - Where the pull's warning lines go (the no-key skip); the worker
 *   passes its own. Defaults to `console.warn`.
 * @returns Resolves when the pull completes or immediately when access is inactive.
 */
export async function runPull(
  db: Db,
  mode: "full" | "incremental" = "full",
  env: NodeJS.ProcessEnv = process.env,
  source?: MockOmieSource,
  matchScope?: MatchCandidateScope,
  log?: (message: string) => void,
): Promise<void> {
  await runOmiePull({
    mode,
    env,
    store: createCadastroImportStore(db, env),
    sync: createSyncRunRecorder(db),
    importStore: createSurfaceImportStore(db),
    source,
    matchScope,
    ...(log ? { log } : {}) });

  // After the import, not inside it: runOmiePull takes the store port rather
  // than Prisma so it can run against memory stores in tests, and a return is a
  // Postgres row. Reconciling here also means a service that only became
  // vehicle-linked on this run (its vehicle identifier arrived in the same
  // pass) opens its return immediately rather than waiting for the next one.
  //
  // Unscoped on purpose: the reconcile is idempotent, so sweeping every vehicle
  // costs an extra read and removes the need to track which ones an import
  // touched — including services that predate returns, which makes this the
  // backfill as well.
  await reconcileVehicleReturnsAfterImport(db);
}
