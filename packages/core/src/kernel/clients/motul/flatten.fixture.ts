/**
 * Shared loaders and builders for the `flattenRecommendation` suites
 * (`flatten.test.ts`, `flatten.upsell.test.ts`, `flatten.arms.test.ts`):
 * the recorded Motul fixtures and goldens beside this file, and the minimal
 * product and entry builders the edge cases start from.
 *
 * Split out of `flatten.test.ts` (wave 5.1a) when `packages/motul` moved into
 * `packages/core`, whose files are capped at 300 lines; unchanged but for
 * `export`. Reads files only — no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlatCategoryPart, FlatProduct, FlatRecommendation } from "./flatten.js";
import type { MotulRecommendation, MotulRecommendationEntry } from "./wire.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(__dirname, "./fixtures");
export const GOLDEN = join(__dirname, "./golden");

export function normalizePart(p: FlatCategoryPart) {
  return JSON.parse(JSON.stringify(p)) as FlatCategoryPart;
}

export function normalizeFlat(flat: FlatRecommendation) {
  const parts: Record<string, FlatCategoryPart> = {};
  for (const [key, part] of Object.entries(flat.parts)) {
    parts[key] = normalizePart(part);
  }
  return JSON.parse(
    JSON.stringify({
      vehicle: flat.vehicle,
      parts,
      ...(flat.notes ? { notes: flat.notes } : {}),
    }),
  ) as unknown;
}

export function loadGolden(name: string) {
  return JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), "utf8"));
}

export function loadFixture(name: string): MotulRecommendation {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
    vehicle: MotulRecommendation;
  };
  return raw.vehicle;
}

export function cloneVehicle(name: string): MotulRecommendation {
  return structuredClone(loadFixture(name));
}

export function minimalProduct(
  overrides: Partial<MotulRecommendationEntry["products"][0]> & {
    name: string;
    emg: string;
  },
): MotulRecommendationEntry["products"][0] {
  const base = loadFixture("simple.json").components[0].recommendations[0]
    .products[0];
  return { ...base, ...overrides };
}

export function minimalEntry(
  products: MotulRecommendationEntry["products"],
  mileage = "0-150 000km",
): MotulRecommendationEntry {
  return {
    conditions: { usage: "Normal", mileage },
    products,
  };
}

export function nonMotorParts(flat: FlatRecommendation) {
  return Object.entries(flat.parts).filter(([key]) => key !== "motor");
}

export function allProducts(part: FlatCategoryPart): FlatProduct[] {
  if (part.byCondition) {
    return part.byCondition.flatMap((v) => v.products);
  }
  return part.products ?? [];
}
