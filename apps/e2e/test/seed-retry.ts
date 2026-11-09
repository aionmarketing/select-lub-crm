/**
 * Riding over the loopback forwarder's dropped connections at start of run.
 *
 * WHAT WAS MEASURED. `seedE2eFixtures` died 14 times across 9 full runs with
 * `PrismaClientInitializationError: Can't reach database server at
 * 127.0.0.1:5433`. Every one of those 14 landed in test #2 or test #4 of the
 * 30-test suite; not once in tests 5..30. Meanwhile Postgres was up and
 * healthy for the whole window and logged no refusal, no termination and no
 * "too many connections" — so the connection never reached it, and peak usage
 * was 15 against a `max_connections` of 100.
 *
 * WHAT THAT MEANS. In the first seconds of a run, three dev servers boot while
 * the provisioning step's migrate and seed processes tear their own
 * connections down, and Docker Desktop's loopback forwarder drops connections
 * under that churn. It is not the container, not connection exhaustion, and
 * not a race with provisioning — provisioning's own migrate and seed connect
 * successfully through the same port moments earlier.
 *
 * INFERRED, NOT CONFIRMED. "The forwarder drops it" fits every measurement
 * but is not proven, and a competing explanation fits too: `ERR_NO_BUFFER_SPACE`
 * (WSAENOBUFS) surfaced in the same suite, and Windows socket-resource
 * exhaustion under burst would produce this symptom with no Docker involved.
 * What would settle it is a paired probe at the same instant — one connection
 * from the host through `127.0.0.1:5433`, one from INSIDE the container where
 * no forwarder exists. Run once against a full suite it gave 0/90 and 0/90,
 * but that run passed 30/30, so it discriminated nothing. Nothing below
 * depends on the answer: the thing to wait on is Postgres accepting a
 * connection, whoever is dropping it.
 *
 * WHY A RETRY IS THE SIGNAL HERE AND NOT A PATCH. There is nothing to wait
 * for in the app: the thing to wait on is Postgres accepting the connection,
 * and the only way to observe that is to attempt one. So this retries the
 * attempt rather than sleeping a guessed duration. It is deliberately narrow
 * in two directions: only a CONNECTIVITY failure is retried, never a data
 * error, so a genuine defect still fails on its first occurrence; and the
 * attempts are bounded, so a real outage fails the suite instead of hanging
 * it. `seedE2eFixtures` is upsert-based and idempotent, which is what makes
 * re-running it safe.
 */

/** How the caller supplies waiting, so tests need no timers. */
type RetryOptions = {
  /** Total attempts including the first. */
  attempts: number;
  /** Delay between attempts; injected so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
};

/** Base backoff; the forwarder recovers in well under a second in practice. */
const BACKOFF_MS = 250;

/**
 * Decides whether a failure is the loopback forwarder dropping a connection.
 *
 * Matches on Prisma's initialization error, which is raised only when the
 * client cannot establish a connection at all — a query that reached the
 * server and failed raises a different class. Narrow on purpose: retrying a
 * data error would re-run a seed over its own half-applied writes and would
 * hide a real defect behind a retry.
 *
 * @param error - Thrown value, of unknown shape.
 * @returns True when the failure is connectivity rather than data.
 */
export function isTransientConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "PrismaClientInitializationError" &&
    /can't reach database server/i.test(error.message)
  );
}

/**
 * Runs the seed, retrying only a dropped connection.
 *
 * @param seed - The seeding call; must be idempotent, as `seedE2eFixtures` is.
 * @param options - Attempt budget and the sleep to use between attempts.
 * @returns Nothing; resolves once the seed has succeeded.
 * @throws The original error — immediately for a data failure, or after the
 *   attempt budget is spent for a connectivity one.
 */
export async function seedWithConnectionRetry(
  seed: () => Promise<void>,
  options: RetryOptions,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await seed();
      return;
    } catch (error) {
      if (!isTransientConnectionFailure(error) || attempt >= options.attempts) {
        throw error;
      }
      await options.sleep(BACKOFF_MS * attempt);
    }
  }
}
