/**
 * Factory that picks a real, mock, or in-memory Omie adapter from process environment.
 */
import type { OmieAdapter } from "./adapter.js";
import { createFakeOmie } from "./fake.js";
import { createHttpOmieAdapter } from "./http.js";
import { createMockOmie } from "./mock/source.js";

/**
 * Returns whether both Omie API credentials are present and non-whitespace.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `true` when `OMIE_APP_KEY` and `OMIE_APP_SECRET` are both set and non-empty after trim.
 */
export function omieCredentialsConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.OMIE_APP_KEY?.trim() && env.OMIE_APP_SECRET?.trim());
}

/**
 * Returns whether the explicit mock Omie opt-in is set (`OMIE_MOCK=1`).
 *
 * Separate from credentials: absence of keys is not treated as mock.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `true` when `OMIE_MOCK` trims to `"1"`.
 */
export function omieMockOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMIE_MOCK?.trim() === "1";
}

/** Which Omie source background work should use. */
export type OmieAccessKind = "credentials" | "mock" | "inactive";

/**
 * Resolves credentials → mock opt-in → inactive for Omie background work.
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `"credentials"` when both keys are set (mock flags ignored, including
 *   `OMIE_MOCK_DATASET`), `"mock"` when `OMIE_MOCK=1` and keys are absent, otherwise `"inactive"`.
 */
export function resolveOmieAccess(env: NodeJS.ProcessEnv = process.env): OmieAccessKind {
  if (omieCredentialsConfigured(env)) {
    return "credentials";
  }
  if (omieMockOptIn(env)) {
    return "mock";
  }
  return "inactive";
}

/**
 * Returns an HTTP Omie adapter when credentials are configured, the mock client port when
 * `OMIE_MOCK=1` and keys are absent, otherwise an empty in-memory fake (local cadastro).
 *
 * @param env - Environment map to read; defaults to `process.env`.
 * @returns `OmieAdapter` for cadastro field sync. Worker pull uses {@link resolveOmieAccess} and no-ops when `"inactive"`.
 */
export function createOmieAdapter(
  env: NodeJS.ProcessEnv = process.env,
): OmieAdapter {
  if (omieCredentialsConfigured(env)) {
    return createHttpOmieAdapter({
      appKey: env.OMIE_APP_KEY as string,
      appSecret: env.OMIE_APP_SECRET as string,
    });
  }
  if (omieMockOptIn(env)) {
    return createMockOmie(env).clients;
  }
  return createFakeOmie();
}
