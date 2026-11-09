/**
 * The plate-lookup port binding: `bindPlacas` / `placas()`, over the plate
 * adapters in this folder (moved from `packages/placas` in wave 5.1a).
 *
 * `plate-lookup` is the only module that uses it, but it is bound at the
 * composition root like every other third party, so a test binds a fake without
 * the slice knowing.
 *
 * The port is nullable on purpose. `createPlacasProvider` returns `null` when
 * `resolvePlacasAccess` reports `inactive` — no token configured, the provider
 * is deliberately off — and `apps/api` already distinguishes that from "not
 * wired". Collapsing the two would turn a deployment with no plate credentials
 * into a crash at the first request instead of the refusal it serves today, so
 * "bound to nothing" and "never bound" stay separate states here.
 */
import { createPlacasProvider } from "./create-adapter.js";
import type { PlateProvider } from "./port.js";

let bound: PlateProvider | null | undefined;
let didBind = false;

/**
 * Binds the plate provider at the composition root.
 *
 * @param provider - The adapter, or `null` when the provider is inactive.
 */
export function bindPlacas(provider: PlateProvider | null): void {
  bound = provider;
  didBind = true;
}

/**
 * The bound plate provider.
 *
 * @returns The provider, or `null` when the root bound nothing because the
 *   provider is inactive. The caller refuses the lookup; it does not invent one.
 * @throws When `bindPlacas` was never called — a slice reaching a port the root
 *   did not wire is a wiring bug, and should say so rather than act on a fake.
 */
export function placas(): PlateProvider | null {
  if (!didBind) throw new Error("placas port is not bound; call bindPlacas at the composition root");
  return bound ?? null;
}

/**
 * The production provider, as `apps/api` builds it today.
 *
 * @returns The adapter for the configured access mode, or `null` when the
 *   provider is inactive.
 */
export function createProductionPlacas(): PlateProvider | null {
  return createPlacasProvider();
}

/** Clears the binding. Tests only, so one file cannot leak a provider into the next. */
export function resetPlacas(): void {
  bound = undefined;
  didBind = false;
}
