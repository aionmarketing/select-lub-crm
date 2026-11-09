/**
 * The quotes module: oil quotes, and the catalog and compatibility data they
 * are priced from. The only file the composition roots import.
 *
 * `createHttpPlugin(ports)` mounts the five HTTP slices. None calls a provider: a
 * quote reads the caches and the research state, and the research itself runs
 * in the worker (`createOilResearchJobs`, over ONE injected `OilResearchPorts`),
 * so the api needs no Motul, Tecfil or OpenAI port for quotes
 * (background-oil-research D15).
 */
import { registerSlice, type HttpPlugin } from "../../kernel/http.js";
import type { RegisterJob } from "../../kernel/jobs.js";
import { route as createQuoteRoute } from "./create-quote/index.js";
import { route as getQuoteOptionsRoute } from "./get-quote-options/index.js";
import { route as refetchOilResearchRoute } from "./refetch-oil-research/index.js";
import { route as recordOilFillVolumeRoute } from "./record-oil-fill-volume/index.js";
import { route as pickOilEngineRoute } from "./pick-oil-engine/index.js";
import type { OmieAdapter } from "../../kernel/clients/erp-mock.js";
import { job as ingestManualsJob, type IngestManualsDeps } from "./ingest-manuals/index.js";
import { job as readManualsJob, type ReadManualsDeps } from "./read-manuals/index.js";
import {
  job as importCatalogJob,
  type ImportCatalogDeps,
} from "./import-catalog-from-erp/index.js";
import type { Db } from "../../kernel/db.js";
import type { OilResearchPorts } from "./internal/research/ports.js";
import type { OilResearchSettings } from "./internal/research/settings.js";
import { job as runOilResearchJob } from "./run-oil-research/index.js";
import { job as sweepOilResearchJob } from "./sweep-oil-research/index.js";

export { upsertCatalogProduct } from "./contracts/upsert-catalog-product.js";
export type { ExtractedOilSpec, OilSpecPorts } from "./internal/pipeline/oil-spec.js";
export type { TecfilFitmentLookup } from "./internal/catalog/tecfil-lookup.js";
/**
 * Logs the research model and effort and, once per pair, each configured model whose (model,
 * effort) has no measured limits and so runs on the placeholder row (background-oil-research D2).
 * A composition root calls it at start-up.
 */
export { reportResearchModel } from "./internal/model-calls/research-model.js";

/** What the quotes HTTP plugin takes: the Omie adapter the engine pick's version write mirrors through (D24). */
export type QuotesHttpPorts = { omieAdapter: OmieAdapter };

/**
 * Builds the module's HTTP plugin: `get-quote-options`, `refetch-oil-research`,
 * `record-oil-fill-volume`, `pick-oil-engine` and `create-quote`.
 *
 * @param ports - The Omie adapter, held in this closure, one per app: the engine pick corrects
 *   the version through the customers contract, which mirrors a vehicle edit to Omie.
 * @returns The plugin the composition root calls with its app.
 */
export function createHttpPlugin(ports: QuotesHttpPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "quotes", "get-quote-options", getQuoteOptionsRoute());
    registerSlice(app, "quotes", "refetch-oil-research", refetchOilResearchRoute());
    registerSlice(app, "quotes", "record-oil-fill-volume", recordOilFillVolumeRoute());
    registerSlice(app, "quotes", "pick-oil-engine", pickOilEngineRoute(ports));
    registerSlice(app, "quotes", "create-quote", createQuoteRoute());
  };
}

export type { ImportCatalogDeps } from "./import-catalog-from-erp/index.js";

/**
 * Builds the module's job registration: `import-catalog-from-erp`.
 *
 * Exported, and deliberately NOT registered by `apps/worker` yet. Today the Omie
 * pull imports the catalog through {@link upsertCatalogProduct}, on its own
 * schedule and `WORKER_OMIE_*` flags; registering this job as well would import
 * every product twice per pull. Wave 3A decomposes the pull and registers it
 * (adopt-modular-vertical-slices 2B.2, option 1).
 *
 * @param deps - The database handle and where the ERP's products are listed from,
 *   held in this closure the way `createHttpPlugin` holds its ports.
 * @returns The module's `jobs(register)`.
 */
export function createJobs(deps: ImportCatalogDeps): (register: RegisterJob) => void {
  return (register) => register(importCatalogJob(deps));
}

export type { IngestManualsDeps } from "./ingest-manuals/index.js";
export { manualIngestionEnabled } from "./ingest-manuals/index.js";

/**
 * Builds the manual-ingestion jobs' registration: `quotes/ingest-manuals` (download and store,
 * PR 2) and `quotes/read-manuals` (read each stored manual once per identity, PR 3).
 *
 * Separate from {@link createJobs} on purpose: `apps/worker` registers THIS one, while
 * `import-catalog-from-erp` stays unregistered until the Omie pull is decomposed. Once
 * registered, the worker downloads recorded manuals on its own (owner-approved background
 * ingestion); `MANUAL_INGESTION_ENABLED=false` switches it off.
 *
 * @param deps - The database handle, the interval, and, for tests, the HTTP client, the text
 *   extractor, the passage selector and the spec extractor.
 * @returns The jobs' `jobs(register)`.
 */
export function createManualIngestionJobs(
  deps: IngestManualsDeps & Pick<ReadManualsDeps, "selectPassage" | "readBy" | "budgetUsd">,
): (register: RegisterJob) => void {
  return (register) => {
    register(ingestManualsJob(deps));
    // The spec extractor is the reading job's own: `deps.extract` is ingestion's text extractor.
    register(
      readManualsJob({
        db: deps.db,
        ...(deps.everyMs ? { everyMs: deps.everyMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.selectPassage ? { selectPassage: deps.selectPassage } : {}),
        ...(deps.readBy ? { readBy: deps.readBy } : {}),
        ...(deps.budgetUsd !== undefined ? { budgetUsd: deps.budgetUsd } : {}),
      }),
    );
  };
}

export type { OilResearchPorts, ResearchRunContext, ResearchStage } from "./internal/research/ports.js";
export type { OilResearchSettings } from "./internal/research/settings.js";
export { createProductionResearchPorts } from "./internal/research/ports.js";

/** What {@link createOilResearchJobs} is built on. */
export type OilResearchJobsDeps = {
  db: Db;
  /** ONE ports object, with no per-port fallback (D21): the worker passes `createProductionResearchPorts(db)`, tests fakes. */
  ports: OilResearchPorts;
  settings: OilResearchSettings;
  now?: () => Date;
};

/**
 * Builds the background oil research jobs' registration (background-oil-research D7, D9):
 * `quotes/sweep-oil-research` (what to research, every minute, and the heartbeat) and
 * `quotes/run-oil-research` (one identity per tick). `apps/worker` registers them only with a
 * database and `OIL_RESEARCH_ENABLED=true`.
 *
 * @param deps - The database handle, the one ports object and the settings.
 * @returns The jobs' `jobs(register)`.
 */
export function createOilResearchJobs(deps: OilResearchJobsDeps): (register: RegisterJob) => void {
  return (register) => {
    register(sweepOilResearchJob({ db: deps.db, settings: deps.settings, keySet: () => deps.ports.keySet(), searchAvailable: () => deps.ports.searchAvailable(), ...(deps.now ? { now: deps.now } : {}) }));
    register(runOilResearchJob({ db: deps.db, ports: deps.ports, settings: deps.settings, ...(deps.now ? { now: deps.now } : {}) }));
  };
}
