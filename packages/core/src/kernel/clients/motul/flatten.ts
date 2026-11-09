/**
 * Flattens Motul recommendation wire payloads into agent-facing oil-spec output.
 * Golden references: `golden/`, beside this file.
 */

import type {
  MotulRecommendation,
  MotulComponent,
  MotulRecommendationEntry,
  RecommendedProduct,
} from "./wire.js";

type Legends = Record<string, string>;

/**
 * Parsed capacity volume from a Motul capacity label, with an optional legend footnote.
 * @example
 * { volume: "4,70" }
 * @example
 * // Legend suffix on wire label `"6,5 - C"` → volume + resolved legend text
 * { volume: "6,5", note: "Volume seco." }
 */
export type FlatCapacity = {
  volume: string;
  note?: string;
};

/** One Motul product in a recommendation band; `recOrder` mirrors Motul `apporder`. */
export type FlatProduct = {
  name: string;
  code: string;
  recOrder: number;
  notes?: string[];
  spec?: string;
  packs?: string[];
  tier?: string;
};

/** One mileage/usage band when Motul product sets diverge across recommendation entries. */
export type FlatConditionVariant = {
  usage: string;
  mileage: string;
  products: FlatProduct[];
  upsell?: FlatProduct[];
};

/** One lubricant category under `parts[categoryName]`; collapsed or split by mileage band when products diverge. */
export type FlatCategoryPart = {
  capacities: FlatCapacity[];
  products?: FlatProduct[];
  byCondition?: FlatConditionVariant[];
  upsell?: FlatProduct[];
};

/** Full flattened recommendation for a resolved vehicle; `parts` keys are Motul `category.name` values. */
export type FlatRecommendation = {
  vehicle: string;
  parts: Record<string, FlatCategoryPart>;
  notes?: string[];
};

const cleanWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

function isEngineComponent(component: MotulComponent): boolean {
  return cleanWhitespace(component.category.name).toLowerCase() === "motor";
}

const CAPACITY_MARK = /^(.*?)\s+-\s+([A-Z])$/;

function resolveLegend(letter: string, legends: Legends): string {
  return legends[letter.toLowerCase()] ?? `(${letter})`;
}

function parseCapacityLabel(label: string, legends: Legends): FlatCapacity {
  const cleaned = cleanWhitespace(label);
  const match = cleaned.match(CAPACITY_MARK);
  if (!match) return { volume: cleaned };
  const [, volume, letter] = match;
  return { volume, note: resolveLegend(letter, legends) };
}

function flattenCapacities(
  component: MotulComponent,
  legends: Legends,
): FlatCapacity[] {
  return component.capacities.map((c) => parseCapacityLabel(c.label, legends));
}

function bandsDiverge(entries: MotulRecommendationEntry[]): boolean {
  const productKey = (e: MotulRecommendationEntry) =>
    e.products
      .map((p) => p.emg)
      .sort()
      .join("|");
  return new Set(entries.map(productKey)).size > 1;
}

function sortByAppOrder(products: RecommendedProduct[]): RecommendedProduct[] {
  return [...products].sort((a, b) => Number(a.apporder) - Number(b.apporder));
}

function parseRecOrder(apporder: string): number {
  const n = Number(apporder);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function resolveObservation(
  product: RecommendedProduct | undefined,
  legends: Legends,
): string | undefined {
  const letter = product?.providerData?.motulExpertObservation;
  if (!letter) return undefined;
  return resolveLegend(letter, legends);
}

function motorProductEnrichment(product: RecommendedProduct) {
  const data = product.details?.normalizedData;
  return {
    spec: [data?.aceaStandards?.value, data?.apiStandards?.value].find(
      (v) => v && v.length > 0,
    ),
    packs: data?.quantities?.value,
    tier: product.recommendationCategory?.title,
  };
}

type EntryUpsell = NonNullable<MotulRecommendationEntry["upsell"]>;

function isHydratedUpsell(value: unknown): value is EntryUpsell {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "emg" in value &&
    "name" in value
  );
}

function detailsEnrichment(details: EntryUpsell["details"] | RecommendedProduct["details"]) {
  const data = details?.normalizedData;
  return {
    spec: [data?.aceaStandards?.value, data?.apiStandards?.value].find(
      (v) => v && v.length > 0,
    ),
    packs: data?.quantities?.value,
  };
}

function upsellRecOrderAfterPeers(catalogProducts: FlatProduct[]): number {
  const maxRec = catalogProducts.reduce(
    (max, product) => Math.max(max, product.recOrder),
    0,
  );
  return maxRec + 1;
}

function flattenUpsellProduct(
  upsell: EntryUpsell,
  isMotor: boolean,
  recOrder: number,
): FlatProduct {
  const flat: FlatProduct = {
    name: upsell.name,
    code: upsell.emg,
    recOrder,
  };

  if (!isMotor) return flat;

  return { ...flat, ...detailsEnrichment(upsell.details) };
}

function flattenEntryUpsell(
  entry: MotulRecommendationEntry,
  catalogProducts: FlatProduct[],
  isMotor: boolean,
): FlatProduct[] | undefined {
  if (!isHydratedUpsell(entry.upsell)) return undefined;
  return [
    flattenUpsellProduct(
      entry.upsell,
      isMotor,
      upsellRecOrderAfterPeers(catalogProducts),
    ),
  ];
}

function flattenProduct(
  product: RecommendedProduct,
  legends: Legends,
  isMotor: boolean,
): FlatProduct {
  const observation = resolveObservation(product, legends);
  const flat: FlatProduct = {
    name: product.name,
    code: product.emg,
    recOrder: parseRecOrder(product.apporder),
    ...(observation ? { notes: [observation] } : {}),
  };

  if (!isMotor) return flat;

  return { ...flat, ...motorProductEnrichment(product) };
}

function flattenProducts(
  entry: MotulRecommendationEntry,
  legends: Legends,
  isMotor: boolean,
): FlatProduct[] {
  return sortByAppOrder(entry.products).map((p) =>
    flattenProduct(p, legends, isMotor),
  );
}

function flattenConditionVariant(
  entry: MotulRecommendationEntry,
  legends: Legends,
  isMotor: boolean,
): FlatConditionVariant | null {
  const products = flattenProducts(entry, legends, isMotor);
  if (products.length === 0) return null;

  const upsell = flattenEntryUpsell(entry, products, isMotor);
  return {
    usage: entry.conditions.usage,
    mileage: entry.conditions.mileage,
    products,
    ...(upsell ? { upsell } : {}),
  };
}

function warnBandsDiverge(component: MotulComponent) {
  console.warn("motul: mileage bands diverge", {
    part: component.category.name,
    bandCount: component.recommendations.length,
    mileageLabels: component.recommendations.map((e) => e.conditions.mileage),
  });
}

function flattenCategoryPart(
  component: MotulComponent,
  legends: Legends,
): FlatCategoryPart | null {
  const entries = component.recommendations;
  if (entries.length === 0) return null;

  const capacities = flattenCapacities(component, legends);
  const isMotor = isEngineComponent(component);

  if (bandsDiverge(entries)) {
    warnBandsDiverge(component);
    const byCondition = entries
      .map((entry) => flattenConditionVariant(entry, legends, isMotor))
      .filter((v): v is FlatConditionVariant => v !== null);
    if (byCondition.length === 0) return null;
    return { capacities, byCondition };
  }

  const entry = entries[0];
  const products = flattenProducts(entry, legends, isMotor);
  if (products.length === 0) return null;

  const upsell = flattenEntryUpsell(entry, products, isMotor);
  return {
    capacities,
    products,
    ...(upsell ? { upsell } : {}),
  };
}

/**
 * Reduces a Motul recommendation payload to agent-facing oil specs.
 *
 * @param raw - Full `MotulRecommendation` from `getOilRecommendation`.
 * @param brand - Resolved catalog brand name passed in because the API returns `brand` empty on the wire.
 * @returns `FlatRecommendation` with `parts` keyed by Motul category name, or `null` when every component lacks products.
 */
export function flattenRecommendation(
  raw: MotulRecommendation,
  brand: string,
): FlatRecommendation | null {
  const legends = raw.extraData?.motulExpertLegends ?? {};
  const parts: Record<string, FlatCategoryPart> = {};

  for (const component of raw.components) {
    const flat = flattenCategoryPart(component, legends);
    if (!flat) continue;

    const key = cleanWhitespace(component.category.name);
    if (parts[key]) {
      console.warn("motul: duplicate category name in flatten", { key });
    }
    parts[key] = flat;
  }

  if (Object.keys(parts).length === 0) return null;

  const years =
    raw.startYear === raw.endYear
      ? raw.startYear
      : `${raw.startYear}-${raw.endYear}`;

  return {
    vehicle: cleanWhitespace(
      [brand, raw.model, raw.type, years].filter(Boolean).join(" "),
    ),
    parts,
  };
}
