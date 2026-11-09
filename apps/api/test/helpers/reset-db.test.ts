/**
 * Test design (testing-strategy)
 *
 * Setup: no fixtures. shouldRunLiveTests() decides which branch this process
 * can reach, same as the *.live.test.ts suites — computed once at module
 * scope so an unusable (non-loopback, unallowed) DATABASE_URL throws here
 * too, instead of masking a misconfigured environment as "skipped".
 *
 * Oracle: openspec/specs/repo-foundation "Database-writing tests require a
 * local target" — an absent DATABASE_URL means the environment is not
 * equipped, so resetTestDatabase() SHALL no-op rather than write.
 *
 * Axes
 *   A1 shouldRunLiveTests() — absent / local / remote(-allowed)
 *
 * P1 VALID — absent: resolves without throwing, without a Prisma call
 * P2 INFEASIBLE (not sampled here) — local or remote-allowed: would TRUNCATE
 *   real tables, so it is exercised only by whichever *.live.test.ts suite
 *   runs resetTestDatabase() in a beforeEach against an actual Postgres, not
 *   by a unit test. assertLiveDbReady's own suite
 *   (assert-live-db-ready.test.ts) covers the "live but prisma null"
 *   divergence this function would otherwise hit on that path.
 */
import { shouldRunLiveTests } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
import { resetTestDatabase } from "./reset-db.js";

const live = shouldRunLiveTests();

describe("resetTestDatabase", () => {
  it.skipIf(live)(
    "no-ops without a database when the environment is not equipped for live tests",
    async () => {
      await expect(resetTestDatabase()).resolves.toBeUndefined();
    },
  );
});
