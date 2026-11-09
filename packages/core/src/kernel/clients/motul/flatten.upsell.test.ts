/**
 * Test design (testing-strategy) — `flattenRecommendation`: upsell, diverging
 * bands and the leftover decisions
 *
 * Split out of `flatten.test.ts` (wave 5.1a) when `packages/motul` moved into
 * `packages/core`, whose files are capped at 300 lines; cases and assertions
 * unchanged. The file's full test-design header (oracle, partitions, decision
 * map) stays in `flatten.test.ts`; the shared loaders are `flatten.fixture.ts`.
 * Reads the recorded fixtures only — no network.
 */
import { describe, expect, it } from "vitest";
import { flattenRecommendation } from "./flatten.js";

import { cloneVehicle, loadFixture, minimalEntry, minimalProduct } from "./flatten.fixture.js";

describe("flattenRecommendation upsell", () => {
  it("maps hydrated entry upsell to FlatProduct[] after catalog products", () => {
    const raw = cloneVehicle("simple.json");
    const motor = raw.components.find((c) => c.category.name === "motor")!;
    const entry = motor.recommendations[0];
    entry.upsell = {
      emg: "13607",
      name: "MOTUL 300V POWER 5W-30",
      pictureUrl: "https://example.com/300v.png",
      details: {
        normalizedData: {
          name: { title: "name", value: "MOTUL 300V POWER 5W-30" },
          emg: { title: "emg", value: "13607" },
          description: { title: "description", value: "" },
          apiStandards: { title: "apiStandards", value: "" },
          jasoStandards: { title: "jasoStandards", value: "" },
          aceaStandards: { title: "aceaStandards", value: "" },
          approvals: { title: "approvals", value: "" },
          performances: { title: "performances", value: "" },
          recommendations: { title: "recommendations", value: "" },
          safetyDataSheetLanguages: [],
          technicalDataSheetHref: {
            title: "technicalDataSheetHref",
            value: "",
          },
          quantities: { title: "quantities", value: ["2L"] },
          upsell: [],
          variants: [],
          defaultVariant: {
            quantity: { title: "quantity", value: "2L" },
            engineType: { title: "engineType", value: "4T" },
            productType: { title: "productType", value: "300V" },
            quality: { title: "quality", value: "" },
            viscosity: { title: "viscosity", value: "5W-30" },
            application: { title: "application", value: "Motor" },
            segment: { title: "segment", value: "Auto" },
            sku: { title: "sku", value: "110814" },
            ean: { title: "ean", value: "" },
          },
          usp: [],
          howToUseImages: [],
        },
        gallery: {},
      },
    };

    const flat = flattenRecommendation(raw, "TEST")!;
    const motorPart = flat.parts.motor!;
    expect(motorPart.upsell).toBeTruthy();
    expect(Array.isArray(motorPart.upsell)).toBe(true);
    expect(motorPart.upsell!.length).toBe(1);
    const ups = motorPart.upsell![0];
    expect(ups.name).toBe("MOTUL 300V POWER 5W-30");
    expect(ups.code).toBe("13607");
    expect(ups.recOrder).toBe(7);
    expect(ups.packs).toEqual(["2L"]);
    expect(ups.spec).toBeUndefined();
    expect(motorPart.products!.every((p) => p.code !== "13607")).toBe(true);
  });

  it("never emits a string upsell on parts or byCondition bands", () => {
    const raw = cloneVehicle("simple.json");
    const motor = raw.components.find((c) => c.category.name === "motor")!;
    motor.recommendations[0].upsell = {
      emg: "13607",
      name: "MOTUL 300V POWER 5W-30",
      pictureUrl: "",
      details: motor.recommendations[0].products[0].details,
    };

    const flat = flattenRecommendation(raw, "TEST")!;
    for (const part of Object.values(flat.parts)) {
      if (Object.hasOwn(part, "upsell")) {
        expect(Array.isArray(part.upsell)).toBe(true);
      }
      if (part.byCondition) {
        for (const variant of part.byCondition) {
          if (Object.hasOwn(variant, "upsell")) {
            expect(Array.isArray(variant.upsell)).toBe(true);
          }
        }
      }
    }
  });

  it("omits upsell when wire sends empty array", () => {
    const flat = flattenRecommendation(
      loadFixture("simple.json"),
      "CHEVROLET (GM)",
    )!;
    expect(flat.parts.motor?.upsell).toBeUndefined();
  });
});

describe("flattenRecommendation diverging bands", () => {
  it("exposes byCondition when a non-motor component has diverging bands", () => {
    const raw = cloneVehicle("simple.json");
    const transmission = raw.components.find((c) =>
      c.category.name.includes("transmissão"),
    )!;
    transmission.recommendations = [
      minimalEntry([minimalProduct({ name: "Product A", emg: "11111" })], "0"),
      minimalEntry(
        [minimalProduct({ name: "Product B", emg: "22222" })],
        "150 000km",
      ),
    ];

    const flat = flattenRecommendation(raw, "TEST")!;
    expect(flat.notes).toBeUndefined();

    const txKey = Object.keys(flat.parts).find((k) =>
      k.includes("transmissão"),
    )!;
    const tx = flat.parts[txKey];
    expect(tx?.products).toBeUndefined();
    expect(tx?.byCondition).toEqual([
      {
        usage: "Normal",
        mileage: "0",
        products: [
          {
            name: "Product A",
            code: "11111",
            recOrder: 4,
          },
        ],
      },
      {
        usage: "Normal",
        mileage: "150 000km",
        products: [
          {
            name: "Product B",
            code: "22222",
            recOrder: 4,
          },
        ],
      },
    ]);
  });

  it("includes motor enrichment on each byCondition product when motor bands diverge", () => {
    const raw = cloneVehicle("simple.json");
    const motor = raw.components.find((c) => c.category.name === "motor")!;
    const baseProducts = motor.recommendations[0].products;
    motor.recommendations = [
      minimalEntry(structuredClone(baseProducts), "-150 000km"),
      minimalEntry(
        [minimalProduct({ name: "Other Oil", emg: "99999" })],
        "+150 000km",
      ),
    ];

    const flat = flattenRecommendation(raw, "TEST")!;
    const motorPart = flat.parts.motor;
    expect(motorPart?.byCondition).toBeTruthy();
    expect(motorPart?.products).toBeUndefined();
    expect(motorPart?.byCondition!.length).toBe(2);
    for (const variant of motorPart!.byCondition!) {
      for (const product of variant.products) {
        expect(product.tier).toBeTruthy();
      }
    }
  });
});

describe("flattenRecommendation leftover decisions", () => {
  it("returns null when every component lacks a usable product", () => {
    const raw = cloneVehicle("simple.json");
    raw.components = raw.components.map((component) => ({
      ...component,
      recommendations: [],
    }));

    expect(flattenRecommendation(raw, "TEST")).toBeNull();
  });

  it("keeps a capacity volume when the label has no legend suffix", () => {
    const raw = cloneVehicle("simple.json");
    const motor = raw.components.find((component) => component.category.name === "motor")!;
    motor.capacities = [{ label: "4,70" }];

    const flat = flattenRecommendation(raw, "TEST")!;
    expect(flat.parts.motor?.capacities).toEqual([{ volume: "4,70" }]);
  });
});
