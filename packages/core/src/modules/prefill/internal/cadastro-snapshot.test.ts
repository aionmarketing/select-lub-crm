/**
 * Test design (testing-strategy) — `selectPlateSourcedKeys`, pure.
 *
 * Moved from `apps/worker/src/prefill/store.test.ts`, its two pure cases,
 * assertions unchanged. Its database cases moved to `drain-prefill`'s tests.
 *
 * Spec: `snapshot.plateSourcedKeys` is make/model/version/year with origin
 * `PLACA` only, sorted.
 *
 * Axes: A1 origin — PLACA / CRM; A2 key — allowed four / odometerKm / plate
 */
import { describe, expect, it } from "vitest";
import { selectPlateSourcedKeys } from "./cadastro-snapshot.js";

describe("selectPlateSourcedKeys", () => {
  it("keeps only PLACA make/model/version/year and sorts them", () => {
    expect(
      selectPlateSourcedKeys([
        { fieldKey: "year", origin: "PLACA" },
        { fieldKey: "odometerKm", origin: "PLACA" },
        { fieldKey: "make", origin: "PLACA" },
        { fieldKey: "model", origin: "CRM" },
        { fieldKey: "plate", origin: "PLACA" },
      ]),
    ).toEqual(["make", "year"]);
  });

  it("returns an empty list when no plate-sourced rows exist", () => {
    expect(selectPlateSourcedKeys([{ fieldKey: "make", origin: "CRM" }])).toEqual([]);
  });
});
