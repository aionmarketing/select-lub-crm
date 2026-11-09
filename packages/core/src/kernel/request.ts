/**
 * What a slice handler can read off the app and the request.
 *
 * Two things, both put there by the composition root before any module's
 * plugin is registered:
 *
 * - **The database handle**, as a Fastify decoration. `bindDb(app, db)` puts it
 *   on the instance and a handler reads `request.server.db`. A decoration, not a
 *   process-global binder like `bindErp`, because the test harness builds a
 *   `Db` per test over that test's rollback transaction: each test builds its
 *   own app, so each gets its own handle, and nothing has to be rebound or can
 *   escape the transaction.
 * - **The caller**, as the `crm*` request fields. `auth/hook.ts` resolves them
 *   — the bearer token, the CRM profile, `X-Unit-Id` against the caller's
 *   memberships, and the 401/403 answers. The field declarations live here, so
 *   a slice can read what that hook wrote. (The hook was `apps/api`'s until
 *   wave 5.2, which moved it here and dropped the kernel's unused
 *   `kernel/auth.ts`.)
 *
 * A module's own ports (an LLM extractor, a follow-up count) are not decorated
 * here. The module exports `createHttpPlugin(ports)` returning its
 * `HttpPlugin`; see `modules/README.md`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The database handle. Set by {@link bindDb}; absent until then. */
    db: Db;
  }
  interface FastifyRequest {
    /** The caller's CRM user id. Set by the auth hook on every authenticated request. */
    crmUserId?: string;
    /** The caller's email, from the CRM profile. */
    crmEmail?: string;
    /** The caller's display name, from the CRM profile. */
    crmName?: string;
    /** Every unit the caller belongs to. Multi-unit reads scope by these. */
    crmUnitIds?: string[];
    /**
     * The unit this request is scoped to: `X-Unit-Id` when the caller is a
     * member of it (anything else is already a 403), or the caller's only unit.
     * Absent on the few paths the hook exempts from unit scoping.
     */
    crmCurrentUnitId?: string;
  }
}

/**
 * Puts the database handle on the app, for every slice registered on it.
 *
 * Call it once, before registering any module's plugin. A second call throws,
 * because Fastify refuses to redecorate — which is what stops two composition
 * steps from disagreeing about which database the slices write to.
 *
 * @param app - The Fastify instance slices are registered on.
 * @param db - From `createDb`: the Prisma singleton in production, a
 *   transaction-bound handle under the test harness.
 */
export function bindDb(app: FastifyInstance, db: Db): void {
  app.decorate("db", db);
}

/**
 * The unit the request is scoped to, as the auth hook resolved it.
 *
 * @param request - A request past the auth hook.
 * @returns `crmCurrentUnitId`, or `undefined` on a unit-exempt path.
 */
export function unitIdOf(request: FastifyRequest): string | undefined {
  return request.crmCurrentUnitId;
}
