/**
 * Building the Fastify instance, and registering one slice on it.
 *
 * `buildApp` is `apps/api/src/app.ts` with the store wiring and the fourteen
 * `register*Routes` calls taken out: the plugins, the zod type provider, the
 * body limit, the `/api` prefix rewrite. What used to be a route registration
 * becomes a module's `httpPlugin(app)`, which registers its slices.
 *
 * `registerSlice` is the single entry a slice is reached through. The zod
 * schema stays on the route rather than being hand-parsed in the handler,
 * because `fastify-type-provider-zod` already parses at the entry — that is
 * REPR as this framework spells it, and it is what gives `apps/web` a typed
 * contract through `shared-types`, a barrel over each module's `contracts/http.ts`. Bodies use `z.strictObject`, so a key the
 * client did not declare is a 400 rather than a silently ignored field.
 */
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { stripApiPrefix } from "./auth/resolve-unit.js";
import type { ModuleName } from "./db.modules.generated.js";
import { fastifyLoggerOptions } from "./logger.js";

/** The Fastify instance every slice is registered on. */
export type App = FastifyInstance extends infer T ? ReturnType<typeof buildApp> extends Promise<infer A> ? A : T : never;

/** What a module exports to put its routes on the app. */
export type HttpPlugin = (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void> | void;

/** Multipart adds boundary bytes on top of the declared media limit. */
const MULTIPART_BODY_SLACK = 1024 * 1024;

// The `/api` rewrite is apps/api's, which keeps the query string (`/api?q=1` →
// `/?q=1`). The kernel's own copy dropped that case; wave 5.2 converged on it.
export { stripApiPrefix };

/** Options for {@link buildApp}. */
export interface BuildAppOptions {
  /** Largest media body accepted, in bytes. */
  mediaMaxBytes: number;
  /** Browser origins allowed by CORS. */
  corsOrigins: readonly string[];
  /** Disables the logger; the test harness passes true. */
  quiet?: boolean;
}

/**
 * Builds the Fastify instance, with no routes on it.
 *
 * @param options - See {@link BuildAppOptions}.
 * @returns A configured, not-yet-listening instance with the zod type provider
 *   attached. The caller registers each module's `httpPlugin` and then listens.
 */
export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.quiet || process.env.VITEST ? false : fastifyLoggerOptions,
    bodyLimit: options.mediaMaxBytes + MULTIPART_BODY_SLACK,
    rewriteUrl: (req) => stripApiPrefix(req.url ?? "/"),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: [...options.corsOrigins] });
  await app.register(multipart, { limits: { fileSize: options.mediaMaxBytes } });

  return app;
}

/** The HTTP verbs a slice may be mounted on. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One slice's route definition, exported from its `index.ts`. */
export interface SliceRoute<Schema> {
  readonly method: Method;
  /** The path, without the `/api` prefix. Unchanged from what the route serves today. */
  readonly path: string;
  /** The zod schema Fastify validates and serialises with. */
  readonly schema: Schema;
  /** The handler. Fastify's own request/reply, already parsed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify infers the request type from `schema` at the call site; naming it here would erase that inference.
  readonly handler: (...args: any[]) => unknown;
}

/**
 * Puts one slice on the app.
 *
 * @param app - From {@link buildApp}.
 * @param module - The module the slice belongs to. Recorded on the route so a
 *   log line and an error name the owner.
 * @param slice - The slice's folder name, e.g. `lookup-plate`.
 * @param route - The slice's `route` export.
 */
export function registerSlice<Schema>(
  app: Awaited<ReturnType<typeof buildApp>>,
  module: ModuleName,
  slice: string,
  route: SliceRoute<Schema>,
): void {
  app.route({
    method: route.method,
    url: route.path,
    schema: route.schema as never,
    handler: route.handler as never,
    config: { module, slice },
  });
}
