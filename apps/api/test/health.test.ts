/**
 * Test design (testing-strategy)
 *
 * Setup: `buildApp({ db: tx })` + `inject("/health")` inside one rolling-back
 *   transaction per test (`withTestTransaction`) on the worktree database. No
 *   network. `vi.stubEnv` supplies the build inputs the Docker image would
 *   carry. No rows are needed: `/health` is exempt from the auth hook and the
 *   handler only probes the connection.
 *
 * Oracle: deploy — "Published images report their build identity". The health
 *   payload carries `commit` and `uiVariant`; an image built without the
 *   commit input reports `unknown` rather than omitting the field; the variant
 *   narrows exactly as the SPA's own module does, so the API cannot claim a
 *   variant the bundle did not get. Also deploy — "Health is reachable": the
 *   path stays public and 2xx.
 *
 * Why through HTTP and not only the resolvers: the route declares a Zod
 *   response schema, and Fastify serializes through it. A field the resolver
 *   returns but the schema omits is dropped silently, so the published origin
 *   would answer without the identity the verification compares. Only an
 *   injected request exercises that serialization.
 *
 * Axes
 *   A1 GIT_COMMIT — a 40-hex SHA / unset
 *   A2 VITE_UI_VARIANT — "antigravity" / unset / garbage
 *
 * Outputs: O1 200 with the SHA; O2 200 with "unknown"; O3 uiVariant
 *   "antigravity"; O4 uiVariant "cursor"
 *
 * Sampled-cell
 *   SHA + antigravity   | A1 A2 | O1 O3 | drop a field from the schema
 *   unset commit        | A1    | O2    | omit the field when unbuilt
 *   unset variant       | A2    | O4    | throw on an absent variant
 *   garbage variant     | A2    | O4    | publish the garbage verbatim
 *
 * ASSERTION THAT ONLY HELD ON THE FAKE
 *   The no-database arm this file used to assert on no longer exists. It built
 *   `buildMemoryApp()`, so `options.db` was undefined, the handler took its
 *   second branch and answered `database: "skipped"`. `buildApp` now requires a
 *   client; that branch is reachable only through the wave-1-only `stores`-only
 *   arm, and wave 4 deletes both. The build fields are therefore asserted here
 *   on `database: "connected"` — the arm a deployed image actually serves —
 *   instead of on a path no deployment can reach. That is the point of removing
 *   the fallback: a misconfigured deploy used to be able to report healthy with
 *   no database behind it.
 *
 * Decision / branch map: the handler's `if (db)` arm is the one taken here and
 *   now the only one a caller can reach, so it is pinned to the exact value
 *   `"connected"` rather than a pattern that would accept either arm.
 *
 * Out of scope: the resolvers themselves (packages/shared-types/src/
 *   build-identity.test.ts); the worker payload (apps/worker/src/
 *   webhook.test.ts); the published origins (apps/e2e/test/remote).
 */
import { afterEach, expect, it, vi } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { describeWithDatabase, withTestTransaction } from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";

const SHA = "a7cdf67b1e4d2c9f08b3a561d7e4c2098fb31d45";

const db = () => prisma as PrismaClient;

/**
 * Asks `/health` on an app built on the test transaction.
 *
 * @param tx - The test transaction; the handler probes it with `SELECT 1`.
 * @returns The status code and the parsed body.
 */
async function health(tx: DbClient) {
  const app = await buildApp({ db: tx });
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    return { status: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describeWithDatabase("GET /health build identity", () => {
  it("reports the commit and variant the image was built with", () =>
    withTestTransaction(db(), async (tx) => {
      vi.stubEnv("GIT_COMMIT", SHA);
      vi.stubEnv("VITE_UI_VARIANT", "antigravity");

      const { status, body } = await health(tx);

      expect(status).toBe(200);
      expect(body).toMatchObject({ status: "ok", commit: SHA, uiVariant: "antigravity" });
      // Pinned exactly: with `db` required there is no "skipped" to get.
      expect(body).toHaveProperty("database", "connected");
    }));

  it("reports unknown rather than omitting the commit when it was not built in", () =>
    withTestTransaction(db(), async (tx) => {
      vi.stubEnv("GIT_COMMIT", "");
      vi.stubEnv("VITE_UI_VARIANT", "cursor");

      const { status, body } = await health(tx);

      expect(status).toBe(200);
      expect(body).toHaveProperty("commit", "unknown");
    }));

  it.each([
    ["unset", ""],
    ["garbage", "antigravty"],
  ])("falls back to cursor when the variant is %s", (_label, value) =>
    withTestTransaction(db(), async (tx) => {
      vi.stubEnv("GIT_COMMIT", SHA);
      vi.stubEnv("VITE_UI_VARIANT", value);

      const { body } = await health(tx);

      expect(body).toHaveProperty("uiVariant", "cursor");
    }));
});
