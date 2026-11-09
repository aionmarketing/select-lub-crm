/**
 * Test design (testing-strategy)
 *
 * Setup: `buildApp({ db: tx })` + `inject("/health")` inside one rolling-back
 *   transaction on the worktree database (`withTestTransaction`); in-process,
 *   no TCP, no `process.env` rewrite.
 *
 * Spec rule (GET /health in apps/api):
 *   200 `{ status: "ok", database: "connected", commit, uiVariant }`.
 *   `commit` and `uiVariant` are build identity; their values are covered by
 *   `src/health.test.ts`. Here they are only required to be PRESENT alongside
 *   the database verdict, because the route serializes through a Zod response
 *   schema that would drop a field it did not declare.
 *
 * Partitions:
 *   P1 VALID — a database client is wired: `database` is "connected".
 *   The "skipped" verdict is unreachable rather than unsampled: `buildApp`
 *   requires a client (route-tests-on-real-database, wave 4), so there is no
 *   arm that answers without one.
 *
 * What would make a test fail:
 *   HTTP 500; `{ status: "ok" }` without `database`; a payload missing
 *   `commit` or `uiVariant`; `database` anything but "connected".
 *
 * Not in this file: Prisma SELECT 1 throwing mapped to 500 (ops outage).
 */
import { expect, it } from "vitest";
import { prisma } from "@select-lub/core/db";
import { describeWithDatabase, withTestTransaction } from "@select-lub/core/testing";

import { buildApp } from "../src/app.js";

describeWithDatabase("GET /health (inject)", () => {
  it("returns 200 with status ok, database connected and the build identity", () =>
    withTestTransaction(prisma!, async (tx) => {
      const app = await buildApp({ db: tx });
      try {
        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          status: "ok",
          database: "connected",
          commit: expect.any(String),
          uiVariant: expect.stringMatching(/^(cursor|antigravity)$/),
        });
      } finally {
        await app.close();
      }
    }));
});
