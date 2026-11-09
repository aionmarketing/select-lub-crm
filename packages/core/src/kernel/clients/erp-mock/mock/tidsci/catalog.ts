/**
 * Generate-time catalog cache keyed by `(CODIGOMATERIAL, trimmed DESCRICAO)`.
 *
 * Hits stay on disk (gitignored). The worker never calls a model.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Generate-time kind used only to decide whether the product carries viscosity. */
export type TidsciCatalogKind = "oil" | "filter" | "other";

/** One cache entry: source invoice text plus the parsed brand/viscosity/classification/kind. */
export type TidsciCatalogCacheEntry = {
  description: string;
  brand: string;
  viscosity: string | null;
  classification: string | null;
  kind: TidsciCatalogKind;
};

export type TidsciCatalogCache = Record<string, TidsciCatalogCacheEntry>;

/** Material identity plus invoice-line frequency for `--limit` ordering. */
export type TidsciCatalogKey = {
  codigoMaterial: string;
  description: string;
  frequency: number;
};

export type CatalogParseRequest = {
  codigoMaterial: string;
  description: string;
};

/**
 * Injectable catalog parser. Tests stub this; the CLI wires OpenAI.
 *
 * @param input - Material code plus the invoice `DESCRICAO` (the model must not replace that text).
 * @returns Parsed brand / optional viscosity / optional classification / generate-time kind.
 */
export type CatalogMaterialParser = (
  input: CatalogParseRequest,
) => Promise<Omit<TidsciCatalogCacheEntry, "description">>;

/**
 * Builds the cache key for a material + invoice description pair.
 *
 * @param codigoMaterial - `CODIGOMATERIAL` as text; empty is allowed.
 * @param description - Trimmed invoice `DESCRICAO`.
 * @returns Stable key used in `.local/tidsci-catalog-cache.json`.
 */
export function catalogCacheKey(codigoMaterial: string, description: string) {
  return `${codigoMaterial}\t${description}`;
}

/**
 * Loads a catalog cache JSON file. Missing files are an empty cache.
 *
 * @param path - Gitignored cache path.
 * @returns Parsed cache object; unknown files yield `{}`.
 */
export function loadCatalogCache(path: string): TidsciCatalogCache {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as TidsciCatalogCache;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/**
 * Writes the catalog cache, creating parent directories when needed.
 *
 * @param path - Gitignored cache path.
 * @param cache - Full cache to persist.
 */
export function saveCatalogCache(path: string, cache: TidsciCatalogCache) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/**
 * Counts invoice lines per `(code, trimmed description)` across all schemas.
 *
 * @param items - NF line rows.
 * @returns Keys sorted by descending frequency, then code, then description.
 */
export function catalogKeysByFrequency(
  items: Array<{ codigoMaterial: string | null; descricao: string }>,
): TidsciCatalogKey[] {
  const counts = new Map<string, TidsciCatalogKey>();
  for (const item of items) {
    const description = item.descricao.trim();
    if (description === "") {
      continue;
    }
    const codigoMaterial = item.codigoMaterial?.trim() ?? "";
    const key = catalogCacheKey(codigoMaterial, description);
    const existing = counts.get(key);
    if (existing) {
      existing.frequency += 1;
    } else {
      counts.set(key, { codigoMaterial, description, frequency: 1 });
    }
  }
  return [...counts.values()].sort((left, right) => {
    if (right.frequency !== left.frequency) {
      return right.frequency - left.frequency;
    }
    const byCode = left.codigoMaterial.localeCompare(right.codigoMaterial);
    if (byCode !== 0) {
      return byCode;
    }
    return left.description.localeCompare(right.description);
  });
}

/**
 * Picks the next uncached keys in frequency order, up to `limit`.
 *
 * @param keys - Frequency-sorted material keys.
 * @param cache - Current cache (skipped keys).
 * @param limit - Max uncached keys to return; `undefined` means no cap.
 * @returns The slice the parser should run this pass.
 */
export function uncachedKeysToParse(
  keys: TidsciCatalogKey[],
  cache: TidsciCatalogCache,
  limit: number | undefined,
) {
  const uncached = keys.filter((key) => cache[catalogCacheKey(key.codigoMaterial, key.description)] === undefined);
  if (limit === undefined) {
    return uncached;
  }
  return uncached.slice(0, Math.max(0, limit));
}

export type CatalogKindChange = {
  codigoMaterial: string;
  description: string;
  from: TidsciCatalogKind;
  to: TidsciCatalogKind;
};

/**
 * Writes parse results into the cache and records kind flips on refresh.
 *
 * @param cache - Mutable cache (updated in place).
 * @param key - Material being stored.
 * @param parsed - Fresh parse (without description; taken from `key`).
 * @returns A kind-change row when the previous kind differed, otherwise `null`.
 */
export function putCatalogCacheEntry(
  cache: TidsciCatalogCache,
  key: TidsciCatalogKey,
  parsed: Omit<TidsciCatalogCacheEntry, "description">,
): CatalogKindChange | null {
  const cacheKey = catalogCacheKey(key.codigoMaterial, key.description);
  const previous = cache[cacheKey];
  cache[cacheKey] = {
    description: key.description,
    brand: parsed.brand,
    viscosity: parsed.viscosity,
    classification: parsed.classification,
    kind: parsed.kind,
  };
  if (previous && previous.kind !== parsed.kind) {
    return {
      codigoMaterial: key.codigoMaterial,
      description: key.description,
      from: previous.kind,
      to: parsed.kind,
    };
  }
  return null;
}
