/**
 * API Placas (`wdapi2.com.br`) adapter — **post-MVP** fallback. The MVP
 * factory does not construct this hop.
 *
 * The account token sits in the URL path. This module must never log the
 * request URL, and failed results must not carry it.
 */
import { asRecord } from "./record.js";
import { mapApiPlacasData } from "./map-api-placas.js";
import { failedLookup, foundOrNotFound, type PlateProvider } from "./port.js";
import { fetchWithTimeout, PROVIDER_TIMEOUT_MS, readJsonBody, type FetchLike } from "./timeout.js";

/** Vendor name recorded on results and ledger hops. */
export const API_PLACAS = "api-placas";

const API_PLACAS_BASE = "https://wdapi2.com.br/consulta";

/**
 * Builds the request URL. Not exported: callers that logged the return value
 * would leak the token.
 *
 * @param plate - Already-normalized plate.
 * @param token - API Placas path token.
 * @returns `https://wdapi2.com.br/consulta/{plate}/{token}`.
 */
function apiPlacasUrl(plate: string, token: string): string {
  return `${API_PLACAS_BASE}/${plate}/${token}`;
}

/**
 * Builds the fallback HTTP adapter.
 *
 * An empty token returns `not_configured` without calling `fetch`. HTTP 406 is
 * a miss (the plate was queried). HTTP 429 is an exhausted prepaid limit, not
 * a missing vehicle.
 *
 * @param options.token - API Placas token placed in the URL path; whitespace-only is treated as missing.
 * @param options.fetch - `fetch` implementation; tests inject a stub so CI never bills.
 * @param options.timeoutMs - Abort budget; defaults to {@link PROVIDER_TIMEOUT_MS}.
 * @returns A {@link PlateProvider} named `api-placas`.
 */
export function createApiPlacasAdapter(options: {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): PlateProvider {
  const token = options.token.trim();
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;

  return {
    name: API_PLACAS,
    async lookup(plate) {
      if (!token) {
        return failedLookup(API_PLACAS, "not_configured");
      }
      const timed = await fetchWithTimeout(
        doFetch,
        apiPlacasUrl(plate, token),
        { method: "GET" },
        timeoutMs,
      );
      if (timed.kind === "timeout" || timed.kind === "error") {
        return failedLookup(API_PLACAS, "provider_error");
      }
      const body = await readJsonBody(timed.response);
      const status = timed.response.status;
      if (status === 429) {
        return failedLookup(API_PLACAS, "exhausted_balance");
      }
      if (status === 401) {
        return failedLookup(API_PLACAS, "not_configured");
      }
      if (status === 406) {
        return foundOrNotFound(
          {},
          { source: "provider", provider: API_PLACAS, billed: true },
        );
      }
      if (status !== 200) {
        return failedLookup(API_PLACAS, "provider_error");
      }
      // Same guard as `agregados-propria`: a 200 whose body is not a JSON object
      // is a provider error wearing a success status, and must not be cached as a
      // permanent miss (`plate-lookup/spec.md:55` and :57). It matters more here
      // than there, because this provider bills every 200 unconditionally — so a
      // gateway error page was both charged to the ledger and remembered forever
      // as a plate that does not exist.
      if (!asRecord(body)) {
        return failedLookup(API_PLACAS, "provider_error");
      }
      return foundOrNotFound(
        mapApiPlacasData(body),
        { source: "provider", provider: API_PLACAS, billed: true },
        body,
      );
    },
  };
}
