/**
 * Shared fetch helpers for the CRM API client (auth and unit headers).
 */
import { useAuthSession } from "../authSession.js";
import { reportRefusedSession } from "../sessionRecovery.js";

export const apiBase = import.meta.env.VITE_API_BASE ?? "/api";

/**
 * Builds Authorization and x-unit-id headers from the session store.
 *
 * @returns Header map; omits a header when that value is missing
 */
export function headers(): HeadersInit {
  const token = useAuthSession.getState().accessToken;
  const unitId = useAuthSession.getState().currentUnitId ?? import.meta.env.VITE_UNIT_ID;
  const next: Record<string, string> = {};
  if (token) {
    next.Authorization = `Bearer ${token}`;
  }
  if (unitId) {
    next["x-unit-id"] = unitId;
  }
  return next;
}

/**
 * How long a single request may go unanswered before it fails.
 *
 * MEASURED, not chosen. 270 read-only samples of the DEPLOYED API's `/health`,
 * which runs `SELECT 1` against the hosted database and so includes the
 * internet hop to Fly.io and the round trip to Supabase: p50 37ms, p95 41-45ms,
 * and exactly ONE sample over 200ms — request index 0, the first after the
 * machine had been idle, at 5688ms. The slow tail is a cold start, not load,
 * and a cold start is precisely the request a user makes when they open the
 * app. A bound under that would turn the normal first page load into an error,
 * which is a worse defect than the one this exists to fix: 3s, the value used
 * in the throwaway experiment that diagnosed this, would have broken every one.
 *
 * 15s is about 2.5x the worst legitimate response observed. It is read from
 * the environment rather than written at each call site so that a later
 * measurement moves it without a code change — which is expected, because
 * those samples were taken from one machine on one network on one evening,
 * `/health` does less work than a list read, and the deploy they measured
 * (bb163e2) is behind `main`. Re-sample after the next deploy.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Reads the configured bound, falling back to the default when the value
 * would not make a working bound.
 *
 * Guarded because the comment above invites people to set this, and the
 * unguarded read failed in exactly the way this module exists to prevent.
 * `Number("20s")` is `NaN`, and a timer given `NaN` fires at once, so a typo
 * made every read reject immediately with "timed out after NaNms" — blaming a
 * timeout rather than the configuration. An empty-but-present value is worse
 * odds for the same outcome: `""` is not nullish, so a `??` default never
 * applied, and `Number("")` is `0`. Zero and negatives are refused too, since
 * neither is a bound anyone means.
 *
 * @param raw - The environment value as Vite exposes it, possibly absent.
 * @returns A positive, finite number of milliseconds.
 */
export function resolveRequestTimeout(raw: string | undefined): number {
  const configured = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export const REQUEST_TIMEOUT_MS = resolveRequestTimeout(import.meta.env.VITE_API_TIMEOUT_MS);

/**
 * Whether `fetch` in this runtime accepts a signal from our `AbortController`.
 *
 * In a browser there is one realm and the answer is always yes. Under jsdom it
 * is no: jsdom supplies `AbortController` but not `fetch`, so the signal and
 * the transport come from different realms and undici refuses it with
 * `Expected signal ("AbortSignal {}") to be an instance of AbortSignal`. The
 * `Request` constructor validates a signal exactly as `fetch` does, so it
 * answers the question without sending anything.
 *
 * Checked once, and used to SKIP attaching the signal rather than to swallow
 * the error. The bound below does not depend on the signal, so skipping it
 * costs only the socket release — and an orphaned read's result is discarded.
 * The distinction matters: this same cross-realm mismatch has been swallowed by
 * a surrounding catch before, which silently disabled the feature under test
 * while every test stayed green.
 *
 * @returns True when the signal can be attached.
 */
function fetchAcceptsOurSignal(): boolean {
  try {
    new Request("http://realm.probe/", { signal: new AbortController().signal });
    return true;
  } catch {
    return false;
  }
}

export const SIGNAL_IS_ATTACHABLE = fetchAcceptsOurSignal();

/**
 * Performs a CRM read with auth headers and a bound on the answer.
 *
 * THE BOUND IS ON THE REQUEST, not on the query lifecycle: React Query's own
 * retry and staleness logic sit above this and are untouched. What this adds
 * is the one thing they cannot supply — a `fetch` that fails. A `fetch` with
 * no signal never rejects, so a lost read stays pending forever, `retry: 1`
 * never fires because there is nothing to retry, and the inbox renders empty
 * as though the unit simply had no conversations.
 *
 * `AbortController` with an explicit timer rather than `AbortSignal.timeout`,
 * so the bound is visible to fake timers and can be tested without waiting
 * fifteen real seconds.
 *
 * @param url - Absolute API URL, normally built from `apiBase`.
 * @param init - Caller's request init; its headers are merged over the auth
 *   ones and its other fields are preserved.
 * @returns The `Response`, for `parse` or for a caller reading bytes.
 * @throws When the request is not answered within `REQUEST_TIMEOUT_MS`, or
 *   for any error `fetch` itself raises.
 */
export async function apiRead(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  let expired: ReturnType<typeof setTimeout> | undefined;

  // The rejection is OURS, raced against the request, rather than something we
  // wait for `fetch` to produce after being aborted. Aborting still happens,
  // so the socket is released — but the bound does not depend on the transport
  // honouring the signal. That matters here: the failure being fixed is a
  // request that never settles, and a guarantee that itself relies on the
  // stuck layer cooperating is not a guarantee.
  const bound = new Promise<never>((_, reject) => {
    expired = setTimeout(() => {
      controller.abort();
      reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      fetch(url, {
        ...init,
        headers: { ...headers(), ...((init.headers as Record<string, string>) ?? {}) },
        ...(SIGNAL_IS_ATTACHABLE ? { signal: controller.signal } : {}),
      }),
      bound,
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      // Named for what happened, so the failure reads as a lost request rather
      // than as an unexplained abort in a log.
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(expired);
  }
}

/**
 * Parses a JSON body after rejecting non-OK HTTP statuses.
 *
 * @param response - Fetch response
 * @returns Parsed JSON
 * @throws Error `http <status>` when `ok` is false
 */
export async function parse(response: Response) {
  if (!response.ok) {
    if (response.status === 401) {
      // The session this request used is refused. Report it and carry on
      // throwing: recovery is asynchronous and de-duplicated, so this neither
      // delays the rejection the caller is waiting for nor starts a second
      // sign-in when several requests are refused at once. Reporting rather
      // than recovering keeps this module free of any auth policy.
      reportRefusedSession();
    }
    throw new Error(`http ${response.status}`);
  }
  return response.json();
}

/**
 * Reads a quoted filename from a Content-Disposition header.
 *
 * @param header - Raw header or null
 * @returns Filename, or null when missing / unquoted
 */
export function filenameFromContentDisposition(header: string | null) {
  if (!header) {
    return null;
  }
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}
