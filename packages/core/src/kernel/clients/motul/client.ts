/**
 * HTTP client for the Motul Oil Advisor API (`gateway-apim.motul.com/oil-advisor`).
 * Sends `locale=pt-BR` and `BU=Brazil`; retries 5xx responses and transient network errors.
 */

import type {
  MotulRecommendation,
  SubModel,
  VehicleBrand,
  VehicleModel,
} from "./wire.js";

/** Motul's own gateway. The default, and the only host a deployment should normally use. */
export const MOTUL_DEFAULT_BASE_URL = "https://gateway-apim.motul.com/oil-advisor";

/**
 * Where the client sends its requests.
 *
 * Read per call rather than once at import, so a test process can point the client somewhere
 * else after this module is already loaded — which is the whole reason the override exists.
 *
 * Motul's API is free and takes no key, so blanking a credential cannot keep a test run off
 * it. Without this seam the only thing standing between the tour suite and Motul's
 * production gateway is a fixture whose identity is too incomplete to reach the client at
 * all: alignment work that completes that identity silently turns every run into outbound
 * traffic against someone else's service. A redirectable host makes "no request leaves for
 * Motul" a configured property instead of an accident.
 */
function baseUrl(): string {
  const raw = process.env.MOTUL_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : MOTUL_DEFAULT_BASE_URL;
}
const MAX_RETRIES = 2;
const BACKOFF_MS = [200, 600] as const;
const REQUEST_TIMEOUT_MS = 8_000;

/** Error thrown when Motul returns a non-retryable HTTP status or exhausts retries on 5xx. */
class MotulError extends Error {
  constructor(
    public path: string,
    public status: number,
  ) {
    super(`motul ${path} status:${status}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Consecutive exhausted-retry failures that open the breaker, when `MOTUL_BREAKER_FAILURES` is unset. */
const BREAKER_FAILURES = 3;

/** How long the breaker stays open, when `MOTUL_BREAKER_COOLDOWN_MS` is unset. Ten minutes. */
const BREAKER_COOLDOWN_MS = 600_000;

/**
 * The gateway's health, as this process has experienced it.
 *
 * Oil Advisor answered 500 to every request for weeks in 2026. Each cold quote still paid
 * the full retry cycle — two backoffs and three requests — before the pipeline could even
 * consider searching the web, so a known-down dependency was charging every customer
 * several seconds of latency to tell us what the previous call already had.
 *
 * Per process, deliberately: one API process and one worker is the whole deployment, and a
 * shared breaker would need a store and a contract for no benefit. Two processes each learn
 * this for themselves, which is correct — one may be able to reach the gateway when the
 * other cannot.
 */
const breaker = { consecutiveFailures: 0, openedAt: 0, lastStatus: 503 };

function breakerFailuresLimit(): number {
  const raw = Number(process.env.MOTUL_BREAKER_FAILURES);
  return Number.isFinite(raw) && raw > 0 ? raw : BREAKER_FAILURES;
}

function breakerCooldownMs(): number {
  const raw = Number(process.env.MOTUL_BREAKER_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : BREAKER_COOLDOWN_MS;
}

/**
 * Whether the breaker is open right now.
 *
 * Opening is a fact about the past; staying open is a decision about the present, so the
 * cool-down is read here rather than stored when it opened.
 */
function breakerIsOpen(): boolean {
  if (breaker.consecutiveFailures < breakerFailuresLimit()) {
    return false;
  }
  return Date.now() - breaker.openedAt < breakerCooldownMs();
}

/**
 * Records that a call exhausted its retries against a gateway that should have answered.
 *
 * A 4xx never gets here: it is not retried and it is not the gateway being down — it is this
 * client asking for something wrong, and no number of those means "stop trying".
 */
function recordBreakerFailure(status: number): void {
  breaker.consecutiveFailures += 1;
  breaker.lastStatus = status;
  if (breaker.consecutiveFailures >= breakerFailuresLimit()) {
    breaker.openedAt = Date.now();
  }
}

/** Closes the breaker: one good answer means the gateway is back. */
function recordBreakerSuccess(): void {
  breaker.consecutiveFailures = 0;
  breaker.openedAt = 0;
}

/**
 * Clears the breaker's memory. Exported for tests, which would otherwise leak an open
 * breaker from one case into the next.
 */
export function resetMotulBreaker(): void {
  recordBreakerSuccess();
  breaker.lastStatus = 503;
}

function isRetryableNetworkError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}

function logRetry(path: string, attempt: number, err: unknown) {
  const status = err instanceof MotulError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`motul: retry ${attempt}/${MAX_RETRIES} for ${path}`, {
    status,
    error: message,
  });
}

/**
 * GET helper for Motul JSON endpoints: 8s timeout, `locale=pt-BR` + `BU=Brazil`, up to two retries.
 *
 * @param path - Path under `gateway-apim.motul.com/oil-advisor` (no leading slash).
 * @param params - Extra query pairs; `locale` and `BU` are always overwritten to Brazil.
 * @returns Parsed JSON body as `T`.
 * @throws {@link MotulError} on 4xx immediately; after retries on persistent 5xx; or the original network/`AbortError` when retries are exhausted.
 */
async function motulGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${baseUrl()}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("locale", "pt-BR");
  url.searchParams.set("BU", "Brazil");

  // A gateway that has failed its way through the retry budget three times running is not
  // going to answer this request either. Fail immediately, with the same error the exhausted
  // path throws, so `resolveOil` still maps it to `unavailable` and the dialog can still
  // offer the previous cache row.
  if (breakerIsOpen()) {
    throw new MotulError(path, breaker.lastStatus);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        recordBreakerSuccess();
        return res.json() as Promise<T>;
      }
      if (res.status < 500) throw new MotulError(path, res.status);
      if (attempt < MAX_RETRIES) {
        logRetry(path, attempt + 1, new MotulError(path, res.status));
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      // Not counted here: this throw is caught by the `catch` below, which is the single
      // place a failure is recorded. Counting in both made two exhausted cycles look like
      // four and opened a three-strike breaker a cycle early.
      throw new MotulError(path, res.status);
    } catch (err) {
      if (err instanceof MotulError && err.status < 500) throw err;
      const retryable =
        err instanceof MotulError ||
        err instanceof TypeError ||
        isRetryableNetworkError(err);
      if (attempt < MAX_RETRIES && retryable) {
        logRetry(path, attempt + 1, err);
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      if (retryable) {
        // Exhausted the budget against something that should have worked — a 5xx or a
        // network failure. A non-retryable error falls through without touching the count.
        recordBreakerFailure(err instanceof MotulError ? err.status : 503);
      }
      throw err;
    }
  }

  throw new Error("motulGet: unreachable");
}

/**
 * Fetches brand rows from Motul `vehicle-brands`.
 *
 * @param categoryId - Motul vehicle category id (e.g. `"CAR"` for passenger cars).
 * @returns Array of brands with catalog ids, display names, and supported model years.
 * @throws `MotulError` on non-retryable HTTP status; retries then throws on persistent 5xx, timeout (`AbortError`), or network `TypeError`.
 */
export const getVehicleBrands = async (categoryId: string) =>
  (await motulGet<{ brands: VehicleBrand[] }>("vehicle-brands", { categoryId }))
    .brands;

/**
 * Fetches model rows from Motul `vehicle-models`.
 *
 * @param vehicleBrandId - Motul brand id from `getVehicleBrands`.
 * @param year - Model year string that must appear in the brand's `years` list.
 * @returns Array of models with catalog ids and display names.
 * @throws `MotulError` on non-retryable HTTP status; retries then throws on persistent 5xx, timeout, or network errors.
 */
export const getVehicleModels = async (vehicleBrandId: string, year: string) =>
  (
    await motulGet<{ models: VehicleModel[] }>("vehicle-models", {
      vehicleBrandId,
      year,
    })
  ).models;

/**
 * Fetches submodel (vehicle type) rows from Motul `vehicle-types`.
 *
 * @param vehicleModelId - Motul model id from `getVehicleModels`.
 * @returns Array of submodels (engine/trim variants) with catalog ids and display names.
 * @throws `MotulError` on non-retryable HTTP status; retries then throws on persistent 5xx, timeout, or network errors.
 */
export const getSubModels = async (vehicleModelId: string) =>
  (await motulGet<{ types: SubModel[] }>("vehicle-types", { vehicleModelId }))
    .types;

/**
 * Fetches the full recommendation vehicle payload from Motul `recommendations`.
 *
 * @param vehicleTypeId - Motul submodel id from `getSubModels`.
 * @returns Raw `MotulRecommendation` wire payload including components, legends, and product rows.
 * @throws `MotulError` on non-retryable HTTP status; retries then throws on persistent 5xx, timeout, or network errors.
 */
export const getOilRecommendation = async (vehicleTypeId: string) =>
  (
    await motulGet<{ vehicle: MotulRecommendation }>("recommendations", {
      vehicleTypeId,
    })
  ).vehicle;

export { MotulError };
