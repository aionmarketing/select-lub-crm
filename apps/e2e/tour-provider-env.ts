/**
 * The provider guard every tour API process starts with — side-effect free.
 *
 * Kept apart from `tours-config.shared.ts` on purpose: that module loads the
 * repository-root `.env` at import time, and the Vitest guard that proves this
 * env keeps the API off every provider (`test/tour-provider-guard.test.ts`) must
 * be able to read the exact values the API receives without pulling real
 * credentials into its own process.
 */

/**
 * Credentials blanked for every tour API.
 *
 * Covers the providers that HAVE a credential. Motul and Tecfil have none and
 * cannot be closed this way — see {@link tourProviderRedirects}.
 */
export const blankedProviderCredentials = {
  OPENAI_API_KEY: "",
  // NOT `PLACAS_TOKEN` — nothing in this repo reads that name. `resolvePlacasAccess`
  // reads THIS one, and resolves credentials before the mock opt-in, so with the
  // token set `PLACAS_MOCK=1` is ignored by design.
  APIBRASIL_BEARER_TOKEN: "",
  OMIE_APP_KEY: "",
  OMIE_APP_SECRET: "",
};

/**
 * Where the Motul and Tecfil clients send requests from a tour API: a loopback
 * port nothing listens on, so any call is refused on this machine instead of
 * leaving for the provider's production host.
 *
 * Neither provider takes a credential and both hosts are compiled into their
 * clients (`MOTUL_DEFAULT_BASE_URL`, `TECFIL_DEFAULT_BASE_URL`), so blanking
 * cannot cover them; the clients read these variables per call. Since
 * background-oil-research the quote path calls neither client at all, so this
 * is the guard that stays true if a later code path does. Port 9 (discard) is
 * chosen because nothing on a developer machine serves HTTP there, and each
 * provider gets its own path so a refused-connection log names which one it was.
 */
export const tourProviderRedirects = {
  MOTUL_BASE_URL: "http://127.0.0.1:9/tour-guard/motul",
  TECFIL_BASE_URL: "http://127.0.0.1:9/tour-guard/tecfil",
};

/** Mock opt-ins every tour API runs with. */
export const tourProviderMocks = {
  OMIE_MOCK: "1",
  PLACAS_MOCK: "1",
};

/**
 * Everything a tour API's env carries to keep it off providers, in the order it
 * is spread over the inherited env: whatever the developer's shell or `.env`
 * says about these names is overridden.
 *
 * @returns A fresh object with the blanked credentials, the redirects and the mocks.
 */
export function tourProviderEnv(): Record<string, string> {
  return { ...blankedProviderCredentials, ...tourProviderRedirects, ...tourProviderMocks };
}
