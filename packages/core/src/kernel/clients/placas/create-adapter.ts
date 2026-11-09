/**
 * Factory that picks the APIBrasil adapter, the canned mock, or inactive — same
 * precedence as `packages/omie/src/create-adapter.ts`.
 *
 * MVP wires APIBrasil only. `API_PLACAS_TOKEN` is ignored here; the API Placas
 * adapter and `composePlateProviders` stay in the package for a post-MVP change.
 */
import { createAgregadosPropriaAdapter } from "./agregados-propria.js";
import { createMockPlateProvider } from "./mock/source.js";
import type { PlateProvider } from "./port.js";
import { PROVIDER_TIMEOUT_MS, type FetchLike } from "./timeout.js";

/**
 * Returns whether the MVP provider token is present and non-whitespace.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `true` when `APIBRASIL_BEARER_TOKEN` is set after trim.
 */
export function placasCredentialsConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.APIBRASIL_BEARER_TOKEN?.trim());
}

/**
 * Returns whether the explicit mock opt-in is set (`PLACAS_MOCK=1`).
 *
 * Separate from credentials: absence of tokens is not treated as mock.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `true` when `PLACAS_MOCK` trims to `"1"`.
 */
export function placasMockOptIn(env: NodeJS.ProcessEnv = process.env) {
  return env.PLACAS_MOCK?.trim() === "1";
}

/** Which plate source the API should use. */
export type PlacasAccessKind = "credentials" | "mock" | "inactive";

/**
 * Resolves credentials → mock opt-in → inactive.
 *
 * `API_PLACAS_TOKEN` is not a credential in the MVP and does not change this
 * result.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `"credentials"` when the APIBrasil token is set (mock flag ignored), `"mock"` when `PLACAS_MOCK=1` and that token is absent, otherwise `"inactive"`.
 */
export function resolvePlacasAccess(
  env: NodeJS.ProcessEnv = process.env,
): PlacasAccessKind {
  if (placasCredentialsConfigured(env)) {
    return "credentials";
  }
  if (placasMockOptIn(env)) {
    return "mock";
  }
  return "inactive";
}

/**
 * Returns the APIBrasil HTTP provider, the mock provider, or `null` when inactive.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @param options.fetch - Injected `fetch` for tests; production omits it.
 * @param options.timeoutMs - Abort budget forwarded to the HTTP adapter.
 * @returns A {@link PlateProvider}, or `null` so the route can report unavailable.
 */
export function createPlacasProvider(
  env: NodeJS.ProcessEnv = process.env,
  options?: { fetch?: FetchLike; timeoutMs?: number },
): PlateProvider | null {
  const access = resolvePlacasAccess(env);
  if (access === "inactive") {
    return null;
  }
  if (access === "mock") {
    return createMockPlateProvider();
  }
  return createAgregadosPropriaAdapter({
    token: env.APIBRASIL_BEARER_TOKEN ?? "",
    fetch: options?.fetch,
    timeoutMs: options?.timeoutMs ?? PROVIDER_TIMEOUT_MS,
  });
}
