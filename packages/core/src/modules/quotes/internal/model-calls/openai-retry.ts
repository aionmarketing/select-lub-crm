/**
 * The one retry an OpenAI research call is allowed (switch-oil-research-to-openai D2; OpenAI's
 * rate-limit guide): a 429 or a 5xx is retried once, after what `Retry-After` asks (capped); a 429
 * for a spent quota (`insufficient_quota`) is never retried — it needs the owner, not a second
 * try, and research pauses on it as on a refused key. The first answer's body is always read
 * (consumed) before the retry, so its connection is released.
 *
 * The SDK's own retries are turned off for these calls (`maxRetries: 0`), so this is the only one:
 * the SDK would retry a quota 429 like any other.
 */
/** Longest the retry waits, whatever `Retry-After` asks: the call's budget is the caller's. */
export const OPENAI_RETRY_MAX_WAIT_MS = 10_000;

/** The wait when a retryable answer carries no usable `Retry-After`. */
export const OPENAI_RETRY_FALLBACK_MS = 2_000;

/** Whether a status earns the one retry: busy (429) or failing (5xx), not refusing. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The wait before the retry, from `Retry-After` in seconds, capped; absent or invalid falls back. */
export function retryWaitMs(header: string | null): number {
  const raw = header?.trim();
  if (!raw) return OPENAI_RETRY_FALLBACK_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return OPENAI_RETRY_FALLBACK_MS;
  return Math.min(seconds * 1_000, OPENAI_RETRY_MAX_WAIT_MS);
}

/** Whether an error body says the account's quota is spent. */
export function isQuotaError(body: string): boolean {
  return /insufficient_quota/.test(body);
}

/** A response built again from a body already read, so the caller can still read it. */
function rebuilt(res: Response, body: string): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Wraps a transport with the one retry.
 *
 * @param base - The transport.
 * @param wait - Sleeps before the retry; a test passes a fake.
 * @param log - Where the retry is logged.
 */
export function withOneRetry(
  base: typeof fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line: string, detail: string) => void = (line, detail) => console.warn(line, detail),
): typeof fetch {
  return async (input, init) => {
    const first = await base(input, init);
    if (!isRetryableStatus(first.status)) return first;
    const body = await first.text();
    if (first.status === 429 && isQuotaError(body)) {
      log("openai-retry", JSON.stringify({ outcome: "quota", status: 429, retried: false }));
      return rebuilt(first, body);
    }
    const waitMs = retryWaitMs(first.headers.get("retry-after"));
    log("openai-retry", JSON.stringify({ outcome: "retry", status: first.status, waitMs }));
    await wait(waitMs);
    if (init?.signal?.aborted) return rebuilt(first, body);
    return base(input, init);
  };
}
