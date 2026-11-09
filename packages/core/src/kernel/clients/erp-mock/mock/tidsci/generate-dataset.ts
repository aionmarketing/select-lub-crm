/**
 * One generate pass: catalog cache → `mapTidsciArchive` → dataset JSON.
 *
 * No Postgres and no OpenAI in this module; the CLI injects those.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MockOmieClient, MockServiceOrder, MockCatalogProduct, MockVehicleIdentifier, MockDuplicatePair } from "../dataset.js";
import type { TidsciArchive } from "./archive-rows.js";
import { mapTidsciArchive } from "./map.js";
import {
  catalogKeysByFrequency,
  loadCatalogCache,
  putCatalogCacheEntry,
  saveCatalogCache,
  uncachedKeysToParse,
  type CatalogKindChange,
  type CatalogMaterialParser,
  type TidsciCatalogCache,
} from "./catalog.js";
import { productsFromCatalogCache } from "./products-from-cache.js";

/** Paths and parse options for one generate run. */
export type GenerateTidsciDatasetInput = {
  archive: TidsciArchive;
  cachePath: string;
  outputPath: string;
  parseMaterial?: CatalogMaterialParser;
  refreshCatalog?: boolean;
  limit?: number;
  openaiApiKey?: string;
};

export type GenerateTidsciDatasetResult = {
  clients: MockOmieClient[];
  serviceOrders: MockServiceOrder[];
  products: MockCatalogProduct[];
  vehicleIds: MockVehicleIdentifier[];
  duplicatePairs: MockDuplicatePair[];
  skippedUncached: number;
  parsed: number;
  kindChanges: CatalogKindChange[];
};

/**
 * Parses up to `limit` uncached materials, maps the archive, and writes dataset JSON.
 *
 * When `OPENAI_API_KEY` is unset and no `parseMaterial` is injected, uncached keys
 * are skipped (Motul + cache hits still yield a loadable dataset). `--refresh-catalog`
 * re-parses cache hits that fall in this run's parse set and reports kind changes.
 *
 * @param input.archive - In-memory four-schema pile.
 * @param input.cachePath - Gitignored `.local/tidsci-catalog-cache.json`.
 * @param input.outputPath - Gitignored `.local/tidsci-omie-dataset.json`.
 * @param input.parseMaterial - Stub or OpenAI parser; unused when the key is already cached and refresh is off.
 * @param input.refreshCatalog - When true, cached keys selected for this run are sent to the parser again.
 * @param input.limit - Max **uncached** (or refresh-selected) keys to parse; omit for no cap.
 * @param input.openaiApiKey - When unset and parser would be needed, skip leftover uncached keys.
 * @returns The mapped dataset plus parse stats. Dataset omits unparsed materials rather than emitting half-formed products.
 */
export async function generateTidsciDataset(
  input: GenerateTidsciDatasetInput,
): Promise<GenerateTidsciDatasetResult> {
  const keys = catalogKeysByFrequency(input.archive.items);
  const cache: TidsciCatalogCache = loadCatalogCache(input.cachePath);
  const canParse = Boolean(input.parseMaterial) || Boolean(input.openaiApiKey?.trim());
  const parser = input.parseMaterial;

  const toParse =
    input.refreshCatalog && canParse && parser
      ? keys.slice(0, input.limit === undefined ? keys.length : Math.max(0, input.limit))
      : uncachedKeysToParse(keys, cache, input.limit);

  const kindChanges: CatalogKindChange[] = [];
  let parsed = 0;
  if (canParse && parser) {
    for (const key of toParse) {
      const result = await parser({
        codigoMaterial: key.codigoMaterial,
        description: key.description,
      });
      parsed += 1;
      const change = putCatalogCacheEntry(cache, key, result);
      if (change) {
        kindChanges.push(change);
      }
    }
  }

  saveCatalogCache(input.cachePath, cache);
  const usedIds = new Set<string>();
  const mapped = mapTidsciArchive(input.archive, [], usedIds);
  const products = productsFromCatalogCache(input.archive, keys, cache, usedIds);
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, `${JSON.stringify({ ...mapped, products }, null, 2)}\n`, "utf8");

  const skippedUncached = keys.filter(
    (key) => cache[`${key.codigoMaterial}\t${key.description}`] === undefined,
  ).length;

  return {
    ...mapped,
    products,
    skippedUncached,
    parsed,
    kindChanges,
  };
}
