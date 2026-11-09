/**
 * APIBrasil `agregados-propria` adapter — the primary plate lookup provider.
 */
import { mapAgregadosPropriaData, apibrasilConsumedCredit } from "./map-agregados.js";
import { failedLookup, foundOrNotFound, type PlateProvider } from "./port.js";
import { asRecord } from "./record.js";
import { fetchWithTimeout, PROVIDER_TIMEOUT_MS, readJsonBody, type FetchLike } from "./timeout.js";

/** Vendor name recorded on results and ledger hops. */
export const AGREGADOS_PROPRIA = "agregados-propria";

/** Credit-debit vehicle lookup on the APIBrasil gateway. */
export const AGREGADOS_PROPRIA_URL =
  "https://gateway.apibrasil.io/api/v2/consulta/veiculos/credits";

/**
 * Builds the primary HTTP adapter.
 *
 * The bearer token travels in the Authorization header. An empty token returns
 * `not_configured` without calling `fetch`. Timeouts and network errors become
 * `provider_error` rather than a miss.
 *
 * @param options.token - APIBrasil bearer token; whitespace-only is treated as missing.
 * @param options.fetch - `fetch` implementation; tests inject a stub so CI never bills.
 * @param options.timeoutMs - Abort budget; defaults to {@link PROVIDER_TIMEOUT_MS}.
 * @returns A {@link PlateProvider} named `agregados-propria`.
 */
export function createAgregadosPropriaAdapter(options: {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): PlateProvider {
  const token = options.token.trim();
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;

  return {
    name: AGREGADOS_PROPRIA,
    async lookup(plate) {
      if (!token) {
        return failedLookup(AGREGADOS_PROPRIA, "not_configured");
      }
      const timed = await fetchWithTimeout(
        doFetch,
        AGREGADOS_PROPRIA_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ placa: plate, tipo: "agregados-propria" }),
        },
        timeoutMs,
      );
      if (timed.kind === "timeout" || timed.kind === "error") {
        return failedLookup(AGREGADOS_PROPRIA, "provider_error");
      }
      const body = await readJsonBody(timed.response);
      const status = timed.response.status;
      if (status === 402) {
        return failedLookup(AGREGADOS_PROPRIA, "exhausted_balance");
      }
      if (status === 403) {
        return failedLookup(AGREGADOS_PROPRIA, "not_configured");
      }
      if (status === 404) {
        const envelope = asRecord(body);
        return foundOrNotFound(
          mapAgregadosPropriaData(envelope?.data),
          {
            source: "provider",
            provider: AGREGADOS_PROPRIA,
            billed: apibrasilConsumedCredit(status, body),
          },
          body,
        );
      }
      if (status !== 200) {
        return failedLookup(AGREGADOS_PROPRIA, "provider_error");
      }
      const envelope = asRecord(body);
      // A 200 whose body is not a JSON object — an HTML gateway page, an empty
      // body — is a provider error wearing a success status. It must not become a
      // miss: `plate-lookup/spec.md:55` stores a miss permanently and defines one
      // as every hop that **actually answered** returning no usable field, while
      // line 57 says a provider error is not stored "because it says nothing about
      // the plate". A gateway page did not answer, and caching it as a miss meant
      // that plate could never be looked up again.
      if (!envelope) {
        return failedLookup(AGREGADOS_PROPRIA, "provider_error");
      }
      const data = envelope.data;
      const billed = apibrasilConsumedCredit(status, body);
      return foundOrNotFound(
        mapAgregadosPropriaData(data),
        { source: "provider", provider: AGREGADOS_PROPRIA, billed },
        body,
      );
    },
  };
}
