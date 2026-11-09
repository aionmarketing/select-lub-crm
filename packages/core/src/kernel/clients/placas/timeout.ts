/**
 * Bounded outbound fetch for plate providers. Matches the Motul client's 8s
 * budget so every paid HTTP call in the repo abandons on the same clock.
 */

/** Milliseconds before a provider call is abandoned. Same value as the Motul client (`../motul/client.ts`). */
export const PROVIDER_TIMEOUT_MS = 8_000;

/** Outcome of {@link fetchWithTimeout}: a response, a timeout, or a network error. */
export type TimedFetchResult =
  | { kind: "response"; response: Response }
  | { kind: "timeout" }
  | { kind: "error" };

/** Injectable `fetch` used by adapters so tests never call a billed URL. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Calls `fetch` and abandons it after `timeoutMs`.
 *
 * Never throws. Timeouts and network errors become tagged results so adapters
 * can map them to `failed` / `provider_error` without leaking the request URL
 * (the API Placas token sits in the path).
 *
 * @param doFetch - `fetch` implementation; tests inject a stub.
 * @param url - Absolute request URL. Callers must not log this argument.
 * @param init - Request init merged with an abort signal; an existing `signal` is overwritten.
 * @param timeoutMs - Budget in milliseconds; `0` still aborts (AbortSignal.timeout treats 0 as immediate).
 * @returns The response, `"timeout"` when the budget elapses, or `"error"` on a network failure.
 */
export async function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<TimedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      ...init,
      signal: controller.signal,
    });
    return { kind: "response", response };
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { kind: "timeout" };
    }
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses a JSON body, returning `undefined` when the response is not JSON.
 *
 * @param response - HTTP response whose body may be JSON, empty, or HTML.
 * @returns Parsed value, or `undefined` on parse failure.
 */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
