/**
 * Builds flat `MockCatalogProduct` rows from Motul seed + catalog-cache hits.
 */
import type { MockCatalogProduct } from "../dataset.js";
import { mockOmieDataset } from "../dataset.js";
import { allocateOmieLookingId } from "./ids.js";
import type { TidsciArchive } from "./archive-rows.js";
import type { TidsciCatalogCache, TidsciCatalogKey } from "./catalog.js";
import { catalogCacheKey } from "./catalog.js";

function latestUnitPrice(
  archive: TidsciArchive,
  codigoMaterial: string,
  description: string,
) {
  let best: { date: number; price: number } | null = null;
  const nfDate = new Map<string, number>();
  for (const nf of archive.nfs) {
    nfDate.set(`${nf.schema}|${nf.nrPedido}`, nf.dataEmissao ?? Number.NEGATIVE_INFINITY);
  }
  for (const item of archive.items) {
    if ((item.codigoMaterial?.trim() ?? "") !== codigoMaterial) {
      continue;
    }
    if (item.descricao.trim() !== description) {
      continue;
    }
    if (item.valorUnitario == null) {
      continue;
    }
    const date = nfDate.get(`${item.schema}|${item.nrPedido}`) ?? Number.NEGATIVE_INFINITY;
    if (!best || date >= best.date) {
      best = { date, price: item.valorUnitario };
    }
  }
  return best?.price ?? 0;
}

function summedStock(archive: TidsciArchive, codigoMaterial: string) {
  let total = 0;
  for (const row of archive.stock) {
    if (row.codigoMaterial.trim() === codigoMaterial) {
      total += row.estoque ?? 0;
    }
  }
  return total;
}

function viscosityForProduct(entry: TidsciCatalogCache[string]) {
  if (entry.kind === "filter") {
    return undefined;
  }
  const viscosity = entry.viscosity?.trim() ?? "";
  if (viscosity === "" || entry.kind !== "oil") {
    return undefined;
  }
  return viscosity;
}

/**
 * Motul (+ Tecfil fixture) seed products, cloned so a generate run cannot mutate the catalog.
 *
 * @returns The small fixture catalog rows that every TIDSCI dataset still includes.
 */
export function motulSeedCatalogProducts(): MockCatalogProduct[] {
  return mockOmieDataset().products;
}

/**
 * Turns cache hits into flat catalog products (optional viscosity/classification on the
 * product itself — no keyed lubricant array). Uncached keys are omitted, not half-formed.
 *
 * @param archive - Used for latest `VALORUNITARIO` and summed `ESTOQUE`.
 * @param keys - Distinct materials discovered on invoice lines.
 * @param cache - Generate-time parse cache.
 * @param usedIds - Shared id set so product ids cannot collide with client/OS/vehicle ids.
 * @returns Motul seed first, then one product per cache hit.
 */
export function productsFromCatalogCache(
  archive: TidsciArchive,
  keys: TidsciCatalogKey[],
  cache: TidsciCatalogCache,
  usedIds: Set<string>,
): MockCatalogProduct[] {
  const products = motulSeedCatalogProducts();
  for (const product of products) {
    usedIds.add(product.omieId);
  }
  for (const key of keys) {
    const entry = cache[catalogCacheKey(key.codigoMaterial, key.description)];
    if (!entry) {
      continue;
    }
    const viscosity = viscosityForProduct(entry);
    const classification =
      viscosity !== undefined ? (entry.classification?.trim() || undefined) : undefined;
    const omieId = allocateOmieLookingId(
      `product|${key.codigoMaterial}|${key.description}`,
      usedIds,
    );
    products.push({
      omieId,
      brand: entry.brand,
      description: key.description,
      price: latestUnitPrice(archive, key.codigoMaterial, key.description),
      stock: summedStock(archive, key.codigoMaterial),
      active: true,
      ...(viscosity !== undefined ? { viscosity } : {}),
      ...(classification !== undefined ? { classification } : {}),
    });
  }
  return products;
}
