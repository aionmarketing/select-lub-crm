/**
 * Default gitignored paths for the TIDSCI mock dataset and catalog cache.
 *
 * Mapped from TIDSCI, not live Omie keys (GitHub #27 / #29 / #5). Real cadastro
 * — never commit these files.
 */
export const DEFAULT_TIDSCI_DATASET_PATH = ".local/tidsci-omie-dataset.json";
export const DEFAULT_TIDSCI_CACHE_PATH = ".local/tidsci-catalog-cache.json";

/**
 * Resolves the dataset JSON path from env, defaulting to {@link DEFAULT_TIDSCI_DATASET_PATH}.
 *
 * @param env - Environment map; `OMIE_MOCK_TIDSCI_PATH` wins when non-empty after trim.
 * @returns Path passed to `readFileSync` / the generate writer.
 */
export function tidsciDatasetPath(env: NodeJS.ProcessEnv = process.env) {
  const override = env.OMIE_MOCK_TIDSCI_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_TIDSCI_DATASET_PATH;
}

/**
 * Resolves the catalog cache path from env, defaulting to {@link DEFAULT_TIDSCI_CACHE_PATH}.
 *
 * @param env - Environment map; `OMIE_MOCK_TIDSCI_CACHE_PATH` is optional.
 * @returns Path for `.local/tidsci-catalog-cache.json` unless overridden.
 */
export function tidsciCatalogCachePath(env: NodeJS.ProcessEnv = process.env) {
  const override = env.OMIE_MOCK_TIDSCI_CACHE_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_TIDSCI_CACHE_PATH;
}

/**
 * Returns whether the TIDSCI-derived dataset opt-in is set.
 *
 * @param env - Environment map.
 * @returns `true` when `OMIE_MOCK_DATASET` trims to `"tidsci"`.
 */
export function isTidsciMockDataset(env: NodeJS.ProcessEnv = process.env) {
  return env.OMIE_MOCK_DATASET?.trim() === "tidsci";
}
