/**
 * Test design (testing-strategy)
 *
 * Setup: pure `tidsciDateToIso`. No HTTP, no DB, no archive.
 *
 * Oracle: omie-mock — integer source dates convert by a documented rule;
 *   undecodable dates stay null rather than an invented calendar day.
 *
 * Axes
 *   A1 epoch — days-since-1800-01-01 / Excel 1899-12-30
 *   A2 year window — 2010–2026 inclusive vs outside
 *   A3 input — finite cluster integer / finite outside / non-finite
 *
 * Outputs: O1 ISO from 1800 epoch; O2 ISO from Excel (only when 1800 is out);
 *   O3 null
 *
 * Sampled-cell
 *   80400 cluster low     | A1 1800 A2 in   | O1 2020-02-17 | Excel 2120 kept
 *   82421 cluster high    | A1 1800 A2 in   | O1 2025-08-30 | Excel 2125 kept
 *   76701 = 2010-01-01    | A2 lower edge   | O1            | null
 *   76700 = 2009-12-31    | A2 lower-1      | O3            | 2009 ISO
 *   82909 = 2026-12-31    | A2 upper edge   | O1            | null
 *   82910 = 2027-01-01    | A2 upper+1      | O3            | 2027 ISO
 *   40179 Excel-only 2010 | A1 Excel A2 in  | O2            | 1800 year kept
 *   NaN / Infinity        | A3 non-finite   | O3            | invented epoch
 *
 * Decision map (date.ts)
 *   D1 Number.isFinite     F non-finite it; T finite its
 *   D2 1800 year in window T cluster + 2010/2026 edges; F 76700, 40179, 82910
 *   D3 Excel year in window T 40179; F cluster (2120s) and 76700
 *
 * Out of scope: live `tid_archive` sampling; timezone other than UTC midnight.
 */
import { describe, expect, it } from "vitest";
import { tidsciDateToIso } from "./date.js";

describe("tidsciDateToIso", () => {
  it("uses days-since-1800-01-01 for the 80400–82421 cluster (Excel 1899-12-30 is year 2120+)", () => {
    expect(tidsciDateToIso(80400)).toBe("2020-02-17T00:00:00.000Z");
    expect(tidsciDateToIso(82421)).toBe("2025-08-30T00:00:00.000Z");
  });

  it("keeps the 2010-01-01 and 2026-12-31 window edges and rejects one day outside", () => {
    expect(tidsciDateToIso(76701)).toBe("2010-01-01T00:00:00.000Z");
    expect(tidsciDateToIso(76700)).toBeNull();
    expect(tidsciDateToIso(82909)).toBe("2026-12-31T00:00:00.000Z");
    expect(tidsciDateToIso(82910)).toBeNull();
  });

  it("falls through to Excel 1899-12-30 when only that epoch lands in 2010–2026", () => {
    expect(tidsciDateToIso(40179)).toBe("2010-01-01T00:00:00.000Z");
  });

  it("returns null for non-finite input rather than inventing a date", () => {
    expect(tidsciDateToIso(Number.NaN)).toBeNull();
    expect(tidsciDateToIso(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
