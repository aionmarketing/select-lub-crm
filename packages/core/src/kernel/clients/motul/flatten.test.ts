/**
 * Test design (testing-strategy)
 *
 * Setup: flattenRecommendation(fixture, brand). Fixtures under
 * the fixtures/ beside this file; goldens under golden/.
 * No Motul HTTP.
 *
 * Spec rule (openspec/specs/quotes/motul-flatten/spec.md):
 *   CRM shape is parts / products / notes / upsell. Drop empty components.
 *   Expert notes stay on the product. No `alternatives` field.
 *   recOrder ascending. Engine-only fields stay on motor.
 *
 * Partitions (one numbered group = Motul JSON the spec treats the same):
 *
 *   P1 VALID   — expert observations on the matching product
 *                (rare-observation.json)
 *   P2 INVALID — capacity legend copied into part notes (must not happen)
 *   P3 VALID   — simple vehicle: no vehicle-level notes
 *   P4 VALID   — products per band sorted by recOrder ascending
 *   P5 INVALID — `alternatives` on a part or variant (must not be emitted)
 *   P6 INVALID — component with zero recommendations → dropped
 *   P7 INVALID — component with empty products → dropped
 *   P8 VALID   — every remaining part has non-empty products + name/code/recOrder
 *   P9 VALID   — golden files: simple, rare-observation, multiple-capacities
 *   P10 INVALID — engine-only fields (spec/packs/tier) on a non-motor part
 *   P11 VALID   — transmission-only.json: ok with no motor component
 *   P12 VALID   — hydrated upsell → FlatProduct[] after catalog products
 *   P13 INVALID — string upsell (must be an array if present)
 *   P14 VALID   — empty upsell array on the wire → omit upsell
 *   P15 VALID   — non-motor diverging mileage bands → byCondition
 *   P16 VALID   — motor diverging bands → byCondition + motor enrichment
 *
 * Output partitions:
 *   O1 — flat object with required product fields (P1/P3/P4/P8/P9/P11/P12/P14/P15/P16)
 *   O2 — forbidden field / dropped component (P2/P5/P6/P7/P10/P13)
 *
 * Limits: none as numbers. Zero recommendations vs one product is
 * present vs missing, not 0 vs 1 vs 2 as a cutoff.
 *
 * Map from each `it` to a partition:
 *
 *   keeps expert observations on the matching product… — P1
 *   does not duplicate capacity legend text into part notes — P2
 *   leaves simple vehicles without vehicle-level notes — P3
 *   lists every Motul product per band sorted by ascending recOrder — P4
 *   never emits an alternatives field on any part or variant — P5
 *   excludes components with zero recommendations — P6
 *   excludes components with empty products — P7
 *   every part has a non-empty products array with required fields — P8
 *   matches golden output for simple|rare-observation|multiple-capacities — P9
 *   never includes engine-only enrichment fields on non-motor parts — P10
 *   returns ok without a motor component — P11
 *   maps hydrated entry upsell to FlatProduct[] after catalog products — P12
 *   never emits a string upsell on parts or byCondition bands — P13
 *   omits upsell when wire sends empty array — P14
 *   exposes byCondition when a non-motor component has diverging bands — P15
 *   includes motor enrichment on each byCondition product when motor bands diverge
 *     — P16
 *   returns null when every component is unusable — spec “No usable components”
 *   keeps a capacity volume without a legend suffix
 *   keeps engine-only enrichment off a non-motor upsell while a motor upsell
 *     keeps it — spec:52-55 + “Non-motor entries stay lean” (:83-86)
 *   drops only the band with no products and keeps the component
 *     — spec:120-125 (“one object per usable band”) + :146-148
 *   sets upsell on a byCondition band, not only on a collapsed part
 *     — spec:96-99 (“that collapsed part or byCondition band”) + :115-119
 *
 * Decision T/F (flatten.ts branches this file reaches)
 *   empty / unusable vehicle → null     T: unusable-all-components; F: goldens
 *   capacity label without ` - L`       T: volume-without-legend; F: legend goldens
 *   non-motor upsell (no enrichment)    T: non-motor upsell it; F: its motor half
 *   band with zero products dropped     T: empty-band it; F: every other band
 *   byCondition band carries upsell     T: band-upsell it; F: its second band
 *   startYear !== endYear               named out of scope (goldens equal years)
 *   unknown legend letter `(X)`         named out of scope
 *   non-numeric apporder                named out of scope
 *   duplicate category.name last-write  named out of scope
 *
 * The four “named out of scope” lines above were re-examined on 2026-09-07
 * against the rule that an out-of-scope label is permitted but not protected.
 * All four stand, and the reason is the same for each: no scenario in ANY
 * motul spec governs them, and no JSDoc states the behaviour either. The words
 * legend, startYear and endYear do not appear anywhere under
 * openspec/specs/motul-*; `resolveLegend` and `parseRecOrder` carry no doc
 * comment; and `flattenRecommendation`'s JSDoc documents its params and its
 * null return while saying nothing about duplicate category names or the years
 * collapse. Each arm is reachable, so none may be called infeasible, and each
 * is unspecified, so none may be given an invented oracle
 * (repo-foundation:114, second paragraph).
 *
 * One-sided decisions that are NOT out of scope — both stronger classes:
 *
 *   `raw.extraData?.motulExpertLegends ?? {}` (flatten.ts:283) —
 *     CONTRACT-HIDDEN, and deliberately not "infeasible". `wire.ts:257`
 *     declares `extraData` as a REQUIRED field of `MotulRecommendation`, so no
 *     value of that type reaches the `?? {}` fallback. But the package performs
 *     NO runtime validation — there is not one zod reference anywhere in it —
 *     so that type is a compile-time promise only: a vendor response that omits
 *     `extraData` produces a value TypeScript forbids and the runtime accepts,
 *     and this fallback is what catches it. Unreachable through the CONTRACT,
 *     not unreachable in fact, which is the distinction the two labels exist to
 *     draw. The practical consequence for a future reader is the opposite of
 *     "stop thinking about it": with nothing else validating a third-party
 *     payload, this defence is load-bearing precisely because it is the only
 *     one.
 *
 *   `if (byCondition.length === 0) return null` (flatten.ts:256) —
 *     UNREACHABLE, i.e. dead code, reported 2026-09-07. Reaching it needs
 *     `bandsDiverge(entries)` true AND every band to flatten to null. A band
 *     flattens to null exactly when it has zero products, and `bandsDiverge`
 *     (flatten.ts:89-96) is `new Set(entries.map(productKey)).size > 1` where a
 *     product-less band's key is the empty string. All bands product-less means
 *     every key is `""`, so the set has size 1 and the diverging branch is
 *     never entered. At most one band can hold the empty key, so entering that
 *     branch guarantees at least one band with products and therefore at least
 *     one non-null variant. The guard cannot fire.
 *
 * Fails if: copying the capacity legend into part notes; emitting
 * `alternatives` on a part; returning an object when every component is empty.
 *
 * Not in this file: live Motul HTTP; motulGet post-loop throw / logRetry
 * non-Error (#26 named infeasible).
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenRecommendation } from "./flatten.js";
import type { MotulComponent } from "./wire.js";

import {
  allProducts,
  cloneVehicle,
  FIXTURES,
  loadFixture,
  loadGolden,
  minimalEntry,
  nonMotorParts,
  normalizeFlat,
} from "./flatten.fixture.js";

describe("flattenRecommendation notes scoping", () => {
  it("keeps expert observations on the matching product, not at part or vehicle level", () => {
    const flat = flattenRecommendation(
      loadFixture("rare-observation.json"),
      "CHEVROLET (GM)",
    )!;

    expect(flat.notes).toBeUndefined();

    const easytronic = flat.parts["transmissão, automática - easytronic"];
    expect(easytronic ? Object.hasOwn(easytronic, "notes") : false).toBe(false);
    expect(easytronic?.capacities[0]).toEqual({
      volume: "0,60",
      note: "Utilizado no sistema de atuação hidráulica do câmbio.",
    });
    expect(easytronic?.products?.[0]?.notes).toEqual([
      "Utilizado no sistema de atuação hidráulica do câmbio.",
    ]);

    expect(
      flat.parts.motor ? Object.hasOwn(flat.parts.motor, "notes") : false,
    ).toBe(false);
    expect(
      allProducts(flat.parts.motor!).every((p) => !p.notes),
    ).toBe(true);
  });

  it("does not duplicate capacity legend text into part notes", () => {
    const flat = flattenRecommendation(
      loadFixture("multiple-capacities.json"),
      "HONDA",
    )!;

    const auto =
      flat.parts["transmissão, automática - automática convencional"];
    expect(auto?.capacities).toEqual([
      { volume: "6,5", note: "Volume seco." },
      { volume: "2,5", note: "Volume em serviço." },
    ]);
    expect(auto ? Object.hasOwn(auto, "notes") : false).toBe(false);
    expect(flat.notes).toBeUndefined();
  });

  it("leaves simple vehicles without vehicle-level notes", () => {
    const flat = flattenRecommendation(
      loadFixture("simple.json"),
      "CHEVROLET (GM)",
    )!;
    expect(flat.notes).toBeUndefined();
    expect(
      flat.parts.motor ? Object.hasOwn(flat.parts.motor, "notes") : false,
    ).toBe(false);
    expect(
      nonMotorParts(flat).every(([, p]) => !Object.hasOwn(p, "notes")),
    ).toBe(true);
  });
});

describe("flattenRecommendation products", () => {
  it("lists every Motul product per band sorted by ascending recOrder", () => {
    const flat = flattenRecommendation(
      loadFixture("simple.json"),
      "CHEVROLET (GM)",
    )!;

    const motor = flat.parts.motor!;
    expect(motor.products?.length).toBe(3);
    const orders = motor.products!.map((p) => p.recOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    for (const p of motor.products!) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.code.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.recOrder)).toBe(true);
    }
  });

  it("never emits an alternatives field on any part or variant", () => {
    const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

    for (const file of fixtures) {
      const flat = flattenRecommendation(loadFixture(file), "TEST")!;
      for (const part of Object.values(flat.parts)) {
        expect(Object.hasOwn(part, "alternatives")).toBe(false);
        expect(Object.hasOwn(part, "product")).toBe(false);
        expect(Object.hasOwn(part, "code")).toBe(false);
        if (part.byCondition) {
          for (const variant of part.byCondition) {
            expect(Object.hasOwn(variant, "alternatives")).toBe(false);
            expect(Object.hasOwn(variant, "product")).toBe(false);
            expect(Object.hasOwn(variant, "code")).toBe(false);
          }
        }
      }
    }
  });
});

describe("flattenRecommendation part filtering", () => {
  it("excludes components with zero recommendations", () => {
    const raw = cloneVehicle("simple.json");
    const emptyPart: MotulComponent = {
      capacities: [{ label: "1,0" }],
      category: { code: "", name: "diferencial traseiro" },
      recommendations: [],
      conditions: { usage: [] },
    };
    raw.components.push(emptyPart);

    const flat = flattenRecommendation(raw, "TEST")!;
    expect(flat.parts["diferencial traseiro"]).toBeUndefined();
  });

  it("excludes components with empty products", () => {
    const raw = cloneVehicle("simple.json");
    const before = Object.keys(
      flattenRecommendation(cloneVehicle("simple.json"), "TEST")!.parts,
    ).length;

    raw.components.push({
      capacities: [{ label: "1,0" }],
      category: { code: "", name: "diferencial traseiro" },
      recommendations: [minimalEntry([])],
      conditions: { usage: [] },
    });

    const flat = flattenRecommendation(raw, "TEST")!;
    expect(Object.keys(flat.parts).length).toBe(before);
    expect(flat.parts["diferencial traseiro"]).toBeUndefined();
  });

  it("every part has a non-empty products array with required fields", () => {
    const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    for (const file of fixtures) {
      const flat = flattenRecommendation(loadFixture(file), "TEST")!;
      for (const part of Object.values(flat.parts)) {
        if (part.byCondition) {
          for (const variant of part.byCondition) {
            expect(variant.products.length).toBeGreaterThan(0);
            for (const p of variant.products) {
              expect(p.name.length).toBeGreaterThan(0);
              expect(p.code.length).toBeGreaterThan(0);
              expect(Number.isFinite(p.recOrder)).toBe(true);
            }
          }
        } else {
          expect(part.products!.length).toBeGreaterThan(0);
          for (const p of part.products!) {
            expect(p.name.length).toBeGreaterThan(0);
            expect(p.code.length).toBeGreaterThan(0);
            expect(Number.isFinite(p.recOrder)).toBe(true);
          }
        }
      }
    }
  });
});

describe("flattenRecommendation golden output", () => {
  const cases = [
    ["simple", "simple.json", "CHEVROLET (GM)"],
    ["rare-observation", "rare-observation.json", "CHEVROLET (GM)"],
    ["multiple-capacities", "multiple-capacities.json", "HONDA"],
  ] as const;

  for (const [golden, fixture, brand] of cases) {
    it(`matches golden output for ${golden}`, () => {
      const flat = flattenRecommendation(loadFixture(fixture), brand)!;
      expect(normalizeFlat(flat)).toEqual(loadGolden(golden));
    });
  }
});

describe("flattenRecommendation parts shape", () => {
  it("never includes engine-only enrichment fields on non-motor parts", () => {
    const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    for (const file of fixtures) {
      const flat = flattenRecommendation(loadFixture(file), "TEST")!;
      for (const [key, part] of nonMotorParts(flat)) {
        for (const product of allProducts(part)) {
          expect(Object.hasOwn(product, "spec"), key).toBe(false);
          expect(Object.hasOwn(product, "packs"), key).toBe(false);
          expect(Object.hasOwn(product, "tier"), key).toBe(false);
        }
      }
    }
  });
});

describe("flattenRecommendation transmission-only", () => {
  it("returns ok without a motor component", () => {
    const flat = flattenRecommendation(
      loadFixture("transmission-only.json"),
      "RENAULT",
    )!;

    expect(flat.parts.motor).toBeUndefined();
    const key = "transmissão, manual - 5 marchas jh3";
    const part = flat.parts[key];
    expect(part).toBeTruthy();
    expect(part.products!.length).toBeGreaterThan(0);
    expect(part.products![0].name.length).toBeGreaterThan(0);
    expect(part.products![0].code.length).toBeGreaterThan(0);
    for (const p of part.products!) {
      expect(Object.hasOwn(p, "spec")).toBe(false);
      expect(Object.hasOwn(p, "alternatives")).toBe(false);
    }
  });
});
