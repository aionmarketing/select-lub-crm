/**
 * Test design (testing-strategy)
 *
 * assertLiveDbReady is pure control flow with one decision (prisma nullish),
 * no database and no shouldRunLiveTests() involved — it exists to convert an
 * already-diverged gate into a loud failure, not to detect the divergence
 * itself (that is shouldRunLiveTests()'s job, tested in packages/core/src/kernel/prisma).
 *
 * Oracle: openspec/specs/repo-foundation "Database-writing tests require a
 * local target" — suites SHALL NOT report a passing run without having run.
 *
 * Axes
 *   A1 prisma — null / undefined / present
 *
 * P1 VALID — null: throws, naming the suite
 * P2 VALID — undefined: throws, naming the suite
 * P3 VALID — present: returns, does not throw
 */
import { describe, expect, it } from "vitest";
import { assertLiveDbReady } from "./assert-live-db-ready.js";

describe("assertLiveDbReady", () => {
  it("throws naming the suite when prisma is null", () => {
    expect(() => assertLiveDbReady(null, "PlateLookupStore prisma")).toThrow(
      /PlateLookupStore prisma/,
    );
  });

  it("throws naming the suite when prisma is undefined", () => {
    expect(() => assertLiveDbReady(undefined, "VehiclePlateOriginStore prisma")).toThrow(
      /VehiclePlateOriginStore prisma/,
    );
  });

  it("does not throw when prisma is present", () => {
    expect(() => assertLiveDbReady({}, "PlateLookupStore prisma")).not.toThrow();
  });
});
