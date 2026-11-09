/**
 * The plate-lookup module: resolving a Brazilian plate to suggested vehicle
 * fields, with a cache and the per-call ledger the provider is billed against.
 * It owns `plate_lookup` and `plate_lookup_call` and writes nothing else.
 *
 * One slice, `lookup-plate` (`POST /plate-lookups`). Other modules read the
 * cache through `contracts/cached-plate.ts`, never through this file.
 */
import type { PlateProvider } from "../../kernel/clients/index.js";
import { registerSlice, type HttpPlugin } from "../../kernel/index.js";
import { route as lookupPlateRoute } from "./lookup-plate/index.js";

/** What the composition root hands this module. */
export interface PlateLookupPorts {
  /**
   * The composed plate provider, or `null` when the feature is inactive (no
   * credentials configured), which the route answers as `unavailable`.
   *
   * Required and never `undefined`, on purpose. This module never constructs a
   * production provider: the "omitted means production" fallback lives only in
   * `apps/api`'s `buildApp`, so there is exactly one place a real, billing
   * client can come from, and a test that forgets the option cannot reach one.
   */
  readonly plateProvider: PlateProvider | null;
}

/**
 * The module's routes, with its ports closed over for this app.
 *
 * The ports live in the closure rather than a module-level binding, so each
 * app — and under the test harness each test's app — gets its own provider.
 *
 * @param ports - See {@link PlateLookupPorts}.
 * @returns The plugin the composition root registers.
 */
export function createHttpPlugin(ports: PlateLookupPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "plate-lookup", "lookup-plate", lookupPlateRoute(ports));
  };
}
