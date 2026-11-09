/**
 * A Fastify app carrying one module's plugin, for a slice's HTTP tests.
 *
 * A slice's status codes, bodies and validation answers are tested in the
 * slice's own `tests/`, through `inject`, without `apps/api`. What this app
 * does not have is the auth hook (`kernel/auth/hook.ts`, which only
 * `apps/api`'s `buildApp` registers): the caller is stated by the test and
 * written onto the request fields that hook would have set. So the hook's own
 * cases — 401 without a token, 403 on a unit the caller is not in — stay in
 * `apps/api/test`, through `buildApp`.
 */
import type { Db } from "../kernel/db.js";
import { buildApp, type HttpPlugin } from "../kernel/http.js";
import { bindDb } from "../kernel/request.js";

/** Who is calling, as `apps/api`'s auth hook would have resolved it. */
export interface SliceCaller {
  readonly userId: string;
  /** The unit the request is scoped to. Omit to test a unit-exempt path. */
  readonly unitId?: string;
  /** Every unit the caller belongs to. Defaults to `[unitId]`. */
  readonly unitIds?: readonly string[];
  readonly email?: string;
  readonly name?: string;
}

/**
 * Builds a quiet app with `db` bound and `plugin` registered.
 *
 * @param options.db - Usually `createDb(tx, runInTransactionOnTx(tx))` inside
 *   `withTestTransaction`, so the slice writes into the test's transaction.
 * @param options.plugin - Built from the slice's own route export, e.g.
 *   `(app) => registerSlice(app, "reports", "report-conversations", route(fakes))`.
 *   A slice's tests may not import the module's `index.ts`, so they mount the
 *   slice's route directly; the module's `createHttpPlugin(ports)` calls the
 *   same route factory, so production and the test mount the identical route.
 * @param options.caller - Omit for an anonymous request.
 * @returns The app. The test closes it.
 */
export async function buildSliceApp(options: {
  db: Db;
  plugin: HttpPlugin;
  caller?: SliceCaller;
}) {
  const app = await buildApp({ mediaMaxBytes: 16 * 1024 * 1024, corsOrigins: [], quiet: true });
  bindDb(app, options.db);
  const caller = options.caller;
  if (caller) {
    app.addHook("onRequest", async (request) => {
      request.crmUserId = caller.userId;
      request.crmEmail = caller.email;
      request.crmName = caller.name;
      request.crmUnitIds = [...(caller.unitIds ?? (caller.unitId ? [caller.unitId] : []))];
      request.crmCurrentUnitId = caller.unitId;
    });
  }
  await options.plugin(app);
  return app;
}
