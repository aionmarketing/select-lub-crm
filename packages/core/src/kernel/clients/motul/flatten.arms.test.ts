/**
 * Test design (testing-strategy) — `flattenRecommendation`: the upsell and band
 * arms the goldens never reach
 *
 * Split out of `flatten.test.ts` (wave 5.1a) when `packages/motul` moved into
 * `packages/core`, whose files are capped at 300 lines; cases, assertions and
 * the hydrated-upsell builder unchanged. The file's full test-design header
 * stays in `flatten.test.ts`; the shared loaders are `flatten.fixture.ts`.
 * Reads the recorded fixtures only — no network.
 */
import { describe, expect, it } from "vitest";
import { flattenRecommendation, type FlatRecommendation } from "./flatten.js";
import type { MotulRecommendation, MotulRecommendationEntry } from "./wire.js";

import { cloneVehicle, minimalEntry, minimalProduct, normalizePart } from "./flatten.fixture.js";

/**
 * A hydrated entry upsell whose details carry ENRICHABLE values — a non-empty
 * `aceaStandards` and a non-empty `quantities`.
 *
 * Non-empty on purpose. The existing P12 fixture leaves both standards at `""`,
 * so `spec` comes out undefined there whether or not enrichment ran, and an
 * "is not enriched" assertion built on it would pass in both directions. These
 * values make the difference between an enriched and an un-enriched upsell
 * observable, which is what lets the motor half of the non-motor test below act
 * as its own control.
 */
function hydratedUpsell(
  name: string,
  emg: string,
): NonNullable<MotulRecommendationEntry["upsell"]> {
  const field = (title: string, value: string) => ({ title, value });
  return {
    emg,
    name,
    pictureUrl: "https://example.com/upsell.png",
    details: {
      normalizedData: {
        name: field("name", name),
        emg: field("emg", emg),
        description: field("description", ""),
        apiStandards: field("apiStandards", ""),
        jasoStandards: field("jasoStandards", ""),
        aceaStandards: field("aceaStandards", "ACEA C3"),
        approvals: field("approvals", ""),
        performances: field("performances", ""),
        recommendations: field("recommendations", ""),
        safetyDataSheetLanguages: [],
        technicalDataSheetHref: field("technicalDataSheetHref", ""),
        quantities: { title: "quantities", value: ["1L", "4L"] },
        upsell: [],
        variants: [],
        defaultVariant: {
          quantity: field("quantity", "1L"),
          engineType: field("engineType", "4T"),
          productType: field("productType", "8100"),
          quality: field("quality", ""),
          viscosity: field("viscosity", "5W-40"),
          application: field("application", "Motor"),
          segment: field("segment", "Auto"),
          sku: field("sku", "110000"),
          ean: field("ean", ""),
        },
        usp: [],
        howToUseImages: [],
      },
      gallery: {},
    },
  };
}

/** The transmission component of simple.json, whichever exact name it carries. */
function transmissionOf(raw: MotulRecommendation) {
  return raw.components.find((c) => c.category.name.includes("transmissão"))!;
}

/** The flattened transmission part, found the same way. */
function transmissionPart(flat: FlatRecommendation) {
  const key = Object.keys(flat.parts).find((k) => k.includes("transmissão"))!;
  return flat.parts[key]!;
}

describe("flattenRecommendation upsell and band arms the goldens never reach", () => {
  it("keeps engine-only enrichment off a non-motor upsell while a motor upsell keeps it", () => {
    // Spec (openspec/specs/quotes/motul-flatten/spec.md:47-50): "Non-motor entries in
    // `products` / `upsell` SHALL NOT include `spec`, `packs`, or `tier`", and
    // the scenario "Non-motor entries stay lean" (:83-86) says "no `products[]`
    // or `upsell[]` entry has `spec` or `tier`". The existing P10 case covers
    // non-motor PRODUCTS; the non-motor UPSELL path was never taken, so the
    // early return in flattenUpsellProduct had only ever been skipped.
    //
    // Both components carry the SAME upsell payload, which is what makes this
    // a test rather than an assumption: the motor half proves the payload is
    // enrichable, so the transmission half asserting absence cannot pass
    // because the data was empty.
    const raw = cloneVehicle("simple.json");
    const motor = raw.components.find((c) => c.category.name === "motor")!;
    motor.recommendations[0].upsell = hydratedUpsell("MOTUL UPSELL MOTOR", "90001");
    transmissionOf(raw).recommendations[0].upsell = hydratedUpsell(
      "MOTUL UPSELL CAIXA",
      "90002",
    );

    const flat = flattenRecommendation(raw, "TEST")!;

    const motorUpsell = flat.parts.motor!.upsell![0]!;
    expect(motorUpsell.spec).toBe("ACEA C3");
    expect(motorUpsell.packs).toEqual(["1L", "4L"]);

    const txUpsell = transmissionPart(flat).upsell![0]!;
    expect(txUpsell.name).toBe("MOTUL UPSELL CAIXA");
    expect(txUpsell.code).toBe("90002");
    expect(normalizePart(transmissionPart(flat)).upsell![0]).not.toHaveProperty("spec");
    expect(normalizePart(transmissionPart(flat)).upsell![0]).not.toHaveProperty("packs");
  });

  it("drops only the band with no products and keeps the component", () => {
    // Spec (:120-125): byCondition carries "one object per USABLE band", and
    // (:146-148) a component is omitted only when every band is unusable. One
    // empty band beside a usable one therefore loses the band, not the part.
    // Never sampled: no fixture had a band with zero products, so the guard in
    // flattenConditionVariant had only ever been skipped.
    const raw = cloneVehicle("simple.json");
    transmissionOf(raw).recommendations = [
      minimalEntry([minimalProduct({ name: "Product A", emg: "11111" })], "0"),
      minimalEntry([], "150 000km"),
    ];

    const flat = flattenRecommendation(raw, "TEST")!;

    const tx = transmissionPart(flat);
    expect(tx.byCondition).toHaveLength(1);
    expect(tx.byCondition![0]!.mileage).toBe("0");
    expect(tx.byCondition![0]!.products.map((p) => p.code)).toEqual(["11111"]);
    // The empty band leaves no trace: not an entry with an empty products
    // array, which would read as "this band recommends nothing".
    expect(tx.byCondition!.some((v) => v.mileage === "150 000km")).toBe(false);
  });

  it("sets upsell on a byCondition band, not only on a collapsed part", () => {
    // Spec (:96-99): a populated upsell object SHALL become `upsell:
    // FlatProduct[]` on "that collapsed part OR `byCondition` band". P12 covers
    // the collapsed part; the band arm was never taken, because every diverging
    // fixture happened to carry no upsell on any band.
    const raw = cloneVehicle("simple.json");
    const withUpsell = minimalEntry(
      [minimalProduct({ name: "Product A", emg: "11111" })],
      "0",
    );
    withUpsell.upsell = hydratedUpsell("MOTUL UPSELL BANDA", "90003");
    transmissionOf(raw).recommendations = [
      withUpsell,
      minimalEntry([minimalProduct({ name: "Product B", emg: "22222" })], "150 000km"),
    ];

    const flat = flattenRecommendation(raw, "TEST")!;

    const bands = transmissionPart(flat).byCondition!;
    expect(bands).toHaveLength(2);
    const [first, second] = bands;
    expect(first!.upsell).toEqual([
      // recOrder sits after the band's own catalog products, per the "Upsell
      // recOrder after catalog products" scenario (:115-119).
      { name: "MOTUL UPSELL BANDA", code: "90003", recOrder: first!.products[0]!.recOrder + 1 },
    ]);
    // The key is omitted, not emitted empty, on the band that has none.
    expect(normalizePart(transmissionPart(flat)).byCondition![1]).not.toHaveProperty("upsell");
    expect(second!.upsell).toBeUndefined();
  });
});
