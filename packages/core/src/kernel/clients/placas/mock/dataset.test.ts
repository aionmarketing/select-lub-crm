/**
 * Test design (testing-strategy)
 *
 * Setup: mockPlacasDataset / mockRowOutcome / createMockPlateProvider. No HTTP.
 *
 * Spec: mock dataset covers several plates plus absent versao, absent
 * modeloDetalhes, and placeholder omissions.
 *
 * Axes
 * A1 row kind — full / no versao / no sintetico / placeholders / miss / unknown plate
 *
 * Outputs: O-found fields including omissions; O-not_found mock
 */
import { describe, expect, it } from "vitest";
import { mockExpectedFields, mockPlacasDataset, mockRowOutcome } from "./dataset.js";
import { createMockPlateProvider } from "./source.js";

describe("mockPlacasDataset", () => {
  it("maps each canned row to the expected outcome including omissions", () => {
    const rows = mockPlacasDataset();
    const byPlate = Object.fromEntries(rows.map((row) => [row.plate, mockRowOutcome(row)]));

    expect(byPlate.ABC1D23).toMatchObject({
      status: "found",
      source: "mock",
      billed: false,
      fields: {
        make: "VW",
        model: "GOL",
        version: "1.0 FLEX 12V 4P",
        year: 2021,
      },
    });
    expect(byPlate.DEF2E34).toMatchObject({
      status: "found",
      fields: { make: "HONDA", model: "FIT", year: 2019 },
    });
    expect(byPlate.GHI1234?.status).toBe("found");
    expect(byPlate.GHI1234?.status === "found" && byPlate.GHI1234.fields.version).toBeUndefined();
    expect(byPlate.JKL1A23).toMatchObject({
      status: "found",
      fields: { model: "ONIX 1.0" },
    });
    expect(byPlate.MNO4B56?.status).toBe("found");
    if (byPlate.MNO4B56?.status === "found") {
      expect(byPlate.MNO4B56.fields.make).toBe("TOYOTA");
      expect(byPlate.MNO4B56.fields.model).toBe("COROLLA");
      expect(byPlate.MNO4B56.fields.version).toBeUndefined();
      expect(byPlate.MNO4B56.fields.fuel).toBeUndefined();
      expect(byPlate.MNO4B56.fields.displacementCc).toBeUndefined();
    }
    expect(byPlate.PQR5678).toMatchObject({ status: "not_found", source: "mock", billed: false });
    expect(mockExpectedFields("GHI1234").version).toBeUndefined();
  });

  it("tags unknown plates as mock not_found", async () => {
    const provider = createMockPlateProvider();
    expect(await provider.lookup("ZZZ1Z99")).toMatchObject({
      status: "not_found",
      source: "mock",
      billed: false,
    });
  });
});
