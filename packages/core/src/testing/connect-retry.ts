/**
 * Riding over a dropped connection when a test transaction opens.
 *
 * The e2e suite measured this first (apps/e2e/test/seed-retry.ts): at start of
 * run, Docker Desktop's loopback forwarder drops connections while several
 * processes churn theirs, and Prisma reports it as
 * `PrismaClientInitializationError: Can't reach database server at
 * 127.0.0.1:5433` while the container is healthy and psql connects. Stream 2A
 * of route-tests-on-real-database then saw the same error on the vitest tier,
 * and every wave since moves more suites onto Postgres, so the whole harness
 * rides over it here rather than each file discovering it.
 *
 * Narrow on purpose, in both directions: only a CONNECTIVITY failure is
 * retried, never a query that reached the server, so a genuine defect still
 * fails on its first occurrence; and the attempts are bounded, so a real
 * outage fails the suite instead of hanging it. Retrying is safe because
 * nothing has run yet when the open fails: the transaction body starts only
 * once the connection is established.
 */

/** How the caller supplies waiting, so tests need no timers. */
export type ConnectRetryOptions = {
  /** Total attempts including the first. */
  attempts: number;
  /** Delay between attempts; injected so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
};

/** Base backoff; the forwarder recovers in well under a second in practice. */
const BACKOFF_MS = 250;

/**
 * Decides whether a failure is a dropped connection rather than a query error.
 *
 * Keyed on the message across Prisma's error classes, not on one class, because
 * the same drop arrives as two of them: `PrismaClientInitializationError` when
 * the client cannot open a connection at all, and `PrismaClientKnownRequestError`
 * when one is dropped while a query is in flight. The first version of this
 * matched only the initialization class and therefore missed the variant that
 * actually failed the live suites, which is the whole reason it is written this
 * way. Neither carries a `code` in this Prisma version, so the message is what
 * there is.
 *
 * Still narrow in the direction that matters: the name must be one of Prisma's
 * client errors, so an ordinary `Error` quoting the text is not retried, and a
 * query that REACHED the server and failed carries a different message and is
 * not retried either. "Can't reach" means the statement never arrived, which is
 * what makes replaying it safe.
 *
 * @param error - Thrown value, of unknown shape.
 * @returns True when the failure is connectivity rather than data.
 */
export function isTransientConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name.startsWith("PrismaClient") && /can'?t reach database server/i.test(error.message)
  );
}

/**
 * Runs `open`, retrying only a dropped connection.
 *
 * @param open - The call that establishes the connection. Must not have side
 *   effects before the connection exists; opening a transaction qualifies.
 * @param options - Attempt budget and the sleep to use between attempts.
 * @returns Whatever `open` resolved with.
 * @throws The original error: immediately for anything but a dropped
 *   connection, or after the attempt budget is spent.
 */
export async function withConnectionRetry<T>(
  open: () => Promise<T>,
  options: ConnectRetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      if (!isTransientConnectionFailure(error) || attempt >= options.attempts) {
        throw error;
      }
      // Say so. A retry that papers over a drop in silence turns a degrading
      // environment into a suite that merely feels slow, and leaves the next
      // person with no way to tell "the retry saved us" from "it never fired".
      console.warn(
        `connect-retry: attempt ${attempt} could not reach the database server; retrying`,
      );
      await options.sleep(BACKOFF_MS * attempt);
    }
  }
}

/** Attempts a wrapped client makes before it gives the failure to the caller. */
const CLIENT_ATTEMPTS = 4;

/** Real waiting, for callers that are not injecting their own. */
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a Prisma client so every operation rides over a dropped connection.
 *
 * For the `*.live.test.ts` suites, which run outside the transaction harness
 * and hand this same client to `buildApp`. That matters: the drop that fails
 * them happens inside a route handler, where the test has nothing to wrap, so
 * the retry has to live in the client both sides share.
 *
 * Test-only. Production keeps the plain client, because a local forwarder
 * dropping connections is not a reason to change how the deployed API behaves.
 *
 * What it does not cover: a drop INSIDE an interactive transaction. The retry
 * would replay the statement against a transaction the server has already lost,
 * which fails with a different error and is rethrown. That is the harness's
 * territory, where the retry wraps opening the transaction instead.
 *
 * @param client - The shared client from `@select-lub/core/db`.
 * @param options - Attempt budget and sleep; defaults to four attempts.
 * @returns A client of the same shape whose operations retry a dropped
 *   connection and nothing else.
 */
export function withConnectRetry<T extends object>(
  client: T,
  options: Partial<ConnectRetryOptions> = {},
): T {
  const attempts = options.attempts ?? CLIENT_ATTEMPTS;
  const sleep = options.sleep ?? realSleep;
  const extended = (client as { $extends: (args: unknown) => unknown }).$extends({
    query: {
      $allOperations({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) {
        return withConnectionRetry(() => query(args), { attempts, sleep });
      },
    },
  });
  // `$extends` returns a branded client type that is structurally the same for
  // every call these suites make. The cast keeps that detail out of ten test
  // files rather than spreading it.
  return extended as T;
}
