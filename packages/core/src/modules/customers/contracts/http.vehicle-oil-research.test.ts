/**
 * Test design (testing-strategy) — the Veículo's oil research flag
 *
 * Setup: zod parse on `vehicleSchema`. No HTTP, no DB.
 *
 * Oracle: background-oil-research `shared-types` delta "Veículo contract" (D18): `oilResearch`
 *   `{ status: "researching" }` parses; an unknown status is dropped while the rest parses; a
 *   Veículo without it, and one with only a customer, still parse.
 *
 * Cells (payload | expected | the bug it would miss)
 *   researching         | carried                          | the field stripped
 *   status "done"       | parses, no oilResearch           | a later status failing the whole list
 *   no oilResearch      | parses, no oilResearch           | the field made required
 *   only customerId     | parses                           | the minimal Veículo broken
 */
import { describe, expect, it } from "vitest";
import { vehicleFixture } from "./http.fixtures.js";
import { vehicleSchema } from "./http.vehicle.js";

describe("Veículo oilResearch", () => {
  it("parses a vehicle being researched and keeps the flag", () => {
    expect(vehicleSchema.parse({ ...vehicleFixture, oilResearch: { status: "researching" } }).oilResearch).toEqual({ status: "researching" });
  });

  it("drops an unknown research status and parses the rest", () => {
    const parsed = vehicleSchema.parse({ ...vehicleFixture, oilResearch: { status: "done" } });

    expect(parsed.oilResearch).toBeUndefined();
    expect(parsed.id).toBe(vehicleFixture.id);
  });

  it("parses a vehicle without the flag", () => {
    expect(vehicleSchema.parse(vehicleFixture).oilResearch).toBeUndefined();
  });

  it("parses a vehicle with only a customer and no plate or year", () => {
    const minimal = { ...vehicleFixture, plate: null, make: null, model: null, version: null, year: null, odometerKm: null };

    expect(vehicleSchema.safeParse(minimal).success).toBe(true);
  });
});
