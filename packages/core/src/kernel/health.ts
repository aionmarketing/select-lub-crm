/**
 * `GET /health` for both composition roots.
 *
 * Moved from `apps/api/src/app.ts` and `apps/worker/src/app.ts` in wave 5.2,
 * unchanged. The api's answer checks the database and names the commit and UI
 * variant; the worker's names the commit only.
 */
import {
  COMMIT_SHA_PATTERN,
  UI_VARIANT_IDS,
  UNKNOWN_COMMIT,
  resolveBuildCommit,
  resolveUiVariant,
  type HealthStatus,
  type WorkerHealthStatus,
} from "../shared/web/build-identity.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbClient } from "./db.js";
import type { HttpPlugin } from "./http.js";

const healthResponse = z.object({
  status: z.literal("ok"),
  database: z.enum(["connected", "skipped"]).optional(),
  // Build identity, so a caller can tell which commit an origin is serving
  // without inferring it from a release date. Validated here as well as
  // resolved: a truncated or garbage SHA fails the route's own response
  // serialization instead of being published as if it were a commit.
  commit: z.union([z.string().regex(COMMIT_SHA_PATTERN), z.literal(UNKNOWN_COMMIT)]),
  uiVariant: z.enum(UI_VARIANT_IDS),
});

/**
 * The api's health route: `SELECT 1`, then the build identity.
 *
 * @param app - From {@link buildApp}.
 * @param db - The raw client the app was built on.
 */
export function registerApiHealth(app: Parameters<HttpPlugin>[0], db: DbClient): void {
  app.get(
    "/health",
    { schema: { response: { 200: healthResponse } } },
    async (): Promise<HealthStatus> => {
      const build = {
        commit: resolveBuildCommit(process.env),
        uiVariant: resolveUiVariant(process.env),
      };
      await db.$queryRaw`SELECT 1`;
      return { status: "ok", database: "connected", ...build };
    },
  );
}

/**
 * The worker's health route.
 *
 * `commit` is the only way to tell which image the always-on worker is
 * running: unlike the api it serves no SPA whose bundle could be inspected.
 *
 * @param app - The webhook app.
 */
export function registerWorkerHealth(app: FastifyInstance): void {
  app.get(
    "/health",
    async (): Promise<WorkerHealthStatus> => ({
      status: "ok",
      commit: resolveBuildCommit(process.env),
    }),
  );
}
