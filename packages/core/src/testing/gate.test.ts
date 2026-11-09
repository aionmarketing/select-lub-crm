/**
 * Test design — the database-writing suite gate.
 *
 * Oracle: openspec/specs/repo-foundation "Database-writing tests require a
 * local target", plus this change's scenario "Route suites skip rather than
 * fake when no database is configured".
 *
 * Decision map (shouldRunDatabaseTests)
 *   no connection string at all            F: skip (false)
 *   DATABASE_URL_TEST loopback             T: run, and it wins over DATABASE_URL
 *   DATABASE_URL loopback, no _TEST        T: run
 *   non-loopback, no override              T: throws naming the host
 *   non-loopback, LIVE_TESTS_ALLOW_REMOTE  T: run
 *
 * Pure: the gate reads an env object, so no database is needed and this file
 * runs everywhere.
 *
 * Out of scope: describeWithDatabase's vitest wiring (a thin skipIf; exercised
 * by every suite that uses it).
 */
import { describe, expect, it } from "vitest";
import { RemoteDatabaseTestTargetError } from "@select-lub/core/db";
import { shouldRunDatabaseTests, testDatabaseUrl } from "./gate.js";

const local = "postgresql://u:p@127.0.0.1:5433/selectlub_test";
const remote = "postgresql://u:p@db.example.supabase.co:5432/postgres";

describe("shouldRunDatabaseTests", () => {
  it("skips when no connection string is configured", () => {
    expect(shouldRunDatabaseTests({})).toBe(false);
  });

  it("runs on a loopback DATABASE_URL_TEST, and prefers it over DATABASE_URL", () => {
    expect(testDatabaseUrl({ DATABASE_URL: remote, DATABASE_URL_TEST: local })).toBe(local);
    expect(shouldRunDatabaseTests({ DATABASE_URL: remote, DATABASE_URL_TEST: local })).toBe(true);
  });

  it("runs on a loopback DATABASE_URL when no test url is set", () => {
    expect(shouldRunDatabaseTests({ DATABASE_URL: local })).toBe(true);
  });

  it("refuses a non-loopback host, naming it, rather than skipping", () => {
    expect(() => shouldRunDatabaseTests({ DATABASE_URL_TEST: remote })).toThrow(
      RemoteDatabaseTestTargetError,
    );
    expect(() => shouldRunDatabaseTests({ DATABASE_URL_TEST: remote })).toThrow(
      /db\.example\.supabase\.co/,
    );
  });

  it("runs on a non-loopback host only with the explicit override", () => {
    expect(
      shouldRunDatabaseTests({ DATABASE_URL_TEST: remote, LIVE_TESTS_ALLOW_REMOTE: "1" }),
    ).toBe(true);
  });
});
