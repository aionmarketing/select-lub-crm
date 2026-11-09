/**
 * Test design (testing-strategy)
 *
 * Setup: createFakeOmie() in-memory Map. No HTTP, no DB.
 *
 * Oracle: design.md D6 (campo names, br↔1058, ISO-2 pass-through,
 * odometerKm number↔string, conteudo max 60 no truncate).
 *
 * Techniques: EP on country / km / length; BVA 59/60/61 is in engine.test.ts
 * (needs synced* and CRM persist). This file samples mapping only.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 country
 *   EP: `br` → wire 1058 → CRM `br`; other ISO-2 (sampled `us`) pass-through
 * A2 odometerKm
 *   EP parseable: number ↔ string; unparseable skip is engine.test.ts (needs lastOmieWire)
 * A3 caracteristica length at adapter
 *   EP invalid: 61 chars → failedKeys includes plate, stored conteudo unchanged
 *
 * Out of scope: D4 decision table; Vehicle.omieId (CRM column; engine R2 plate).
 */
import { describe, expect, it } from "vitest";
import { createFakeOmie } from "./fake.js";
import { BRAZIL_CODIGO_PAIS, CARACTERISTICA_CAMPOS } from "./fields.js";
import { emptySnapshot, readSnapshotField } from "./map.js";

describe("fake Omie adapter mapping", () => {
  it("round-trips country br as codigo_pais 1058", async () => {
    const fake = createFakeOmie();
    fake.seed("omie-1", emptySnapshot());

    await fake.put("omie-1", { country: "br" });
    const snapshot = await fake.get("omie-1");

    expect(snapshot?.codigo_pais).toBe(BRAZIL_CODIGO_PAIS);
    const read = readSnapshotField(snapshot!, "country");
    expect(read.status === "value" && read.crm).toBe("br");
  });

  it("passes through a non-br ISO-2 country", async () => {
    const fake = createFakeOmie();
    fake.seed("omie-1", emptySnapshot());

    await fake.put("omie-1", { country: "us" });
    const snapshot = await fake.get("omie-1");

    expect(snapshot?.codigo_pais).toBe("us");
    const read = readSnapshotField(snapshot!, "country");
    expect(read.status === "value" && read.crm).toBe("us");
  });

  it("round-trips parseable odometerKm as KM string", async () => {
    const fake = createFakeOmie();
    fake.seed("omie-1", emptySnapshot());

    await fake.put("omie-1", { odometerKm: 15000 });
    const snapshot = await fake.get("omie-1");
    const km = snapshot?.caracteristicas.find((row) => row.campo === CARACTERISTICA_CAMPOS.odometerKm);

    expect(km?.conteudo).toBe("15000");
    const read = readSnapshotField(snapshot!, "odometerKm");
    expect(read.status === "value" && read.crm).toBe(15000);
  });

  it("fails a caracteristica put longer than 60 characters without truncating", async () => {
    const fake = createFakeOmie();
    fake.seed("omie-1", {
      ...emptySnapshot(),
      caracteristicas: [{ campo: CARACTERISTICA_CAMPOS.plate, conteudo: "ABC1D23" }],
    });

    const result = await fake.put("omie-1", { plate: "x".repeat(61) });
    const snapshot = await fake.get("omie-1");
    const plate = snapshot?.caracteristicas.find((row) => row.campo === CARACTERISTICA_CAMPOS.plate);

    expect(result.failedKeys).toEqual(["plate"]);
    expect(result.reasons?.plate).toBe("conteudo exceeds 60 characters");
    expect(plate?.conteudo).toBe("ABC1D23");
    expect(plate?.conteudo).not.toHaveLength(60);
  });
});
