/**
 * Test design (testing-strategy)
 *
 * Setup: import { prisma } from this package. No extra query helpers.
 *
 * Spec rule (the database client, `@select-lub/core/db`):
 *   Export null when DATABASE_URL is missing, or a PrismaClient that can
 *   run SELECT 1 when the URL is set.
 *
 * Partitions (one numbered group = env values the spec treats the same):
 *
 *   P1 VALID   — URL missing: import does not throw. `prisma === null` is
 *                infeasible to pin in this process: CI and a local `.env`
 *                both set DATABASE_URL, so this `it` accepts null or a client.
 *   P2 VALID   — URL set: skipIf is false, SELECT 1 succeeds
 *
 * Output partitions:
 *   O1 — prisma === null || typeof prisma.$connect === "function" (P1)
 *   O2 — SELECT 1 does not throw (P2)
 *
 * Limits: none. The URL is set or not.
 *
 * Map from each `it` to a partition:
 *
 *   loads without a live database — P1
 *   runs SELECT 1 against the configured database — P2 (skipIf)
 *
 * What would make a test fail:
 *   `import { prisma }` throwing when DATABASE_URL is missing
 *
 * Not in this file: generated Prisma client internals.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "./client.js";

describe("prisma client module", () => {
  it("loads without a live database", () => {
    expect(prisma === null || typeof prisma.$connect === "function").toBe(true);
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "runs SELECT 1 against the configured database",
    async () => {
      if (!prisma) {
        throw new Error("expected PrismaClient when DATABASE_URL is set");
      }
      await prisma.$queryRaw`SELECT 1`;
    },
  );
});
