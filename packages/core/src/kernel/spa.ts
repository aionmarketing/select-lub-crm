/**
 * Serves the Vite-built CRM SPA and falls back to `index.html` for client-side routes.
 * Skips SPA fallback for `/api`-prefixed paths so JSON 404s stay intact.
 *
 * Moved from `apps/api/src/spa.ts` in wave 5.2. The one change is where the
 * default build directory comes from: it was resolved relative to that file, so
 * the composition root now passes it as `candidate` from the same place.
 */
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isApiRoutePath, requestPath } from "./auth/resolve-unit.js";

/**
 * Resolves the static dist directory from env, override, or the monorepo web build output.
 *
 * @param override - Explicit dist path; pass `null` to skip SPA serving entirely.
 * @param candidate - The monorepo's `apps/web/dist`, used when nothing else names one.
 * @returns Absolute path to the Vite `dist` folder, or `null` when no build is available.
 */
export function resolveSpaRoot(override: string | null | undefined, candidate: string) {
  if (override === null) {
    return null;
  }
  if (override !== undefined) {
    return override;
  }
  if (process.env.SPA_DIST_DIR) {
    return process.env.SPA_DIST_DIR;
  }
  return existsSync(join(candidate, "index.html")) ? candidate : null;
}

/**
 * Registers static file serving and a not-found handler that returns the SPA shell for browser navigation.
 *
 * @param app - Fastify instance to register `@fastify/static` on.
 * @param spaRoot - Absolute path to the built SPA `dist` directory.
 * @returns Resolves when static serving and the SPA fallback handler are registered.
 */
export async function registerSpa(app: FastifyInstance, spaRoot: string) {
  await app.register(fastifyStatic, {
    root: spaRoot,
    wildcard: false,
    index: false,
  });
  app.setNotFoundHandler((request, reply) => {
    const path = requestPath(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({});
    }
    if (isApiRoutePath(path)) {
      return reply.code(404).send({});
    }
    return reply.sendFile("index.html");
  });
}
