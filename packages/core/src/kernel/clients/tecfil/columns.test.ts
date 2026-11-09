/**
 * Test design (testing-strategy)
 *
 * Setup: `columns.ts` exports recorded constants, no HTTP.
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 * — "Fitment carries candidates per filter type with cross-references": "The
 * mapping from grid column to filter type SHALL come from Tecfil's tenant
 * configuration recorded in the package, not from label text." design.md D3
 * names the exact four columns.
 *
 * Techniques: EP is trivial here (one partition: the recorded value); this
 * is a golden-constant assertion pinning the map to the 2026-09-03
 * `tecfil-catalog-config.json` recording, not a behavior to explore.
 *
 * Out of scope: fetching the configuration at runtime (design D3 explicitly
 * rejects this — the column map is a recorded constant).
 */
import { describe, expect, it } from "vitest";
import {
  FUEL_FILTER_COLUMNS,
  OIL_FILTER_COLUMNS,
  TECFIL_COLUMNS_CONFIGURED_AT,
} from "./columns.js";

describe("columns", () => {
  it("maps the recorded grid columns to oil and fuel filter types", () => {
    expect(OIL_FILTER_COLUMNS).toEqual([
      "ComplementoAplicacao3_11",
      "ComplementoAplicacao3_12",
    ]);
    expect(FUEL_FILTER_COLUMNS).toEqual([
      "ComplementoAplicacao3_13",
      "ComplementoAplicacao3_14",
    ]);
  });

  it("records the configuration date", () => {
    expect(TECFIL_COLUMNS_CONFIGURED_AT).toBe("2026-09-03");
  });
});
