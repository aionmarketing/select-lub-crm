/**
 * Test design (testing-strategy)
 *
 * Setup: originWritesFromVehicleBody / vehicleFieldPatch. No HTTP.
 *
 * Oracle: add-plate-lookup plate-lookup spec — whoever writes make/model/
 * version/year owns PLACA vs CRM; omitted keys are left alone; plateSourcedKeys
 * entries that were not written are ignored; odometerKm is never marked.
 *
 * Axes
 *   A1 key present on body — make / omitted
 *   A2 listed in plateSourcedKeys — yes / no / extra year not written
 *
 * Outputs: PLACA write; CRM write; empty writes
 *
 * Sampled-cell
 *   make listed                         | A1 present A2 yes    | PLACA | CRM
 *   make typed, list empty              | A1 present A2 no     | CRM   | PLACA
 *   year listed but omitted from body   | A1 omit A2 extra     | []    | year write
 *   only odometerKm                     | not an identity key  | []    | a write
 *
 * Decision map
 *   Object.hasOwn identity key T: make its; F: omitted/year-extra/odometer its
 *   sourced.has(key) T: listed it; F: typed it
 *
 * Out of scope: Prisma upsert (origin.test.ts); Fastify inject.
 */
import { describe, expect, it } from "vitest";
import { originWritesFromVehicleBody, vehicleFieldPatch } from "./plate-origin.js";

describe("originWritesFromVehicleBody", () => {
  it("marks a listed identity key PLACA", () => {
    expect(
      originWritesFromVehicleBody({ make: "VW", plateSourcedKeys: ["make"] }),
    ).toEqual([{ fieldKey: "make", origin: "PLACA" }]);
  });

  it("marks a typed identity key CRM when it is not listed", () => {
    expect(originWritesFromVehicleBody({ make: "VW", model: "Gol" })).toEqual([
      { fieldKey: "make", origin: "CRM" },
      { fieldKey: "model", origin: "CRM" },
    ]);
  });

  it("ignores a listed key that this body did not write", () => {
    expect(
      originWritesFromVehicleBody({ make: "VW", plateSourcedKeys: ["make", "year"] }),
    ).toEqual([{ fieldKey: "make", origin: "PLACA" }]);
  });

  it("writes nothing for a body that only has odometerKm", () => {
    expect(originWritesFromVehicleBody({ odometerKm: 10_000 } as never)).toEqual([]);
  });
});

describe("vehicleFieldPatch", () => {
  it("drops plateSourcedKeys and keeps vehicle columns", () => {
    expect(
      vehicleFieldPatch({ make: "VW", plateSourcedKeys: ["make"], plate: "ABC1D23" }),
    ).toEqual({ make: "VW", plate: "ABC1D23" });
  });
});
