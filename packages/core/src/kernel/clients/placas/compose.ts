/**
 * Primary-then-fallback cascade for a **post-MVP** API Placas hop.
 *
 * The production factory (`createPlacasProvider`) does not call this. Tests
 * and a later change that wires the fallback keep the cascade in one place.
 */
import {
  collectBilledCalls,
  failedLookup,
  type LookupFailure,
  type LookupResult,
  type PlateProvider,
} from "./port.js";

/** Name recorded when the cascade itself is the answering source. */
export const COMPOSED_PROVIDER = "placas";

function isUnconfigured(result: LookupResult): boolean {
  return result.status === "failed" && result.reason === "not_configured";
}

function failureReason(first: LookupResult, second: LookupResult): LookupFailure {
  const reasons = [first, second]
    .filter((result): result is Extract<LookupResult, { status: "failed" }> => result.status === "failed")
    .map((result) => result.reason);
  if (reasons.includes("exhausted_balance")) {
    return "exhausted_balance";
  }
  if (reasons.includes("not_configured") && reasons.every((reason) => reason === "not_configured")) {
    return "not_configured";
  }
  return "provider_error";
}

/**
 * Calls `primary` first and `fallback` only when the primary errors, times out,
 * is unconfigured, or returns no usable field.
 *
 * A miss is stored only when every provider that actually answered returned
 * `not_found`. If any answering provider failed, the outcome is `failed` so a
 * later attempt retries rather than serving a cached miss. `not_configured` on
 * one hop is treated as that vendor being absent, not as a plate fact.
 *
 * @param primary - APIBrasil `agregados-propria`.
 * @param fallback - API Placas.
 * @returns A {@link PlateProvider} named `placas`.
 */
export function composePlateProviders(
  primary: PlateProvider,
  fallback: PlateProvider,
): PlateProvider {
  return {
    name: COMPOSED_PROVIDER,
    async lookup(plate) {
      const first = await primary.lookup(plate);
      if (first.status === "found") {
        return first;
      }

      const second = await fallback.lookup(plate);
      if (second.status === "found") {
        return {
          ...second,
          billedCalls: collectBilledCalls(first, second),
        };
      }

      const billedCalls = collectBilledCalls(first, second);
      const firstMiss = first.status === "not_found";
      const secondMiss = second.status === "not_found";

      if (firstMiss && secondMiss) {
        return {
          status: "not_found",
          source: "provider",
          provider: COMPOSED_PROVIDER,
          billed: billedCalls.length > 0,
          billedCalls,
        };
      }
      if (firstMiss && isUnconfigured(second)) {
        return { ...first, billedCalls };
      }
      if (isUnconfigured(first) && secondMiss) {
        return { ...second, billedCalls };
      }

      return failedLookup(COMPOSED_PROVIDER, failureReason(first, second), billedCalls);
    },
  };
}
