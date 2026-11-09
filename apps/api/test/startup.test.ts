/**
 * Test design — the startup guard.
 *
 * Oracle: openspec/changes/route-tests-on-real-database, spec "The API does
 * not start without a database", scenario "Missing connection setting fails
 * startup".
 *
 * Decision map (assertDatabaseConfigured)
 *   DATABASE_URL unset        T: throws, message names DATABASE_URL
 *   DATABASE_URL blank        T: throws (whitespace is not a connection string)
 *   DATABASE_URL set          F: returns
 *
 * Pure: reads the env object it is given, so no database is needed.
 *
 * Out of scope: index.ts wiring (a top-level-await entry; it calls this guard
 * before importing the app, which is verified by reading it, not by spawning a
 * process here).
 */
import { describe, expect, it } from "vitest";
import { assertDatabaseConfigured } from "../src/startup.js";

describe("assertDatabaseConfigured", () => {
  it("refuses to start without DATABASE_URL, naming the setting", () => {
    expect(() => assertDatabaseConfigured({})).toThrow(/DATABASE_URL/);
  });

  it("treats a blank value as unset", () => {
    expect(() => assertDatabaseConfigured({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
  });

  it("returns when a connection string is present", () => {
    expect(() =>
      assertDatabaseConfigured({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/x" }),
    ).not.toThrow();
  });
});
