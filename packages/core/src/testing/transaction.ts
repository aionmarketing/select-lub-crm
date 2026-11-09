/**
 * Per-test transaction harness: every store-touching test runs inside a
 * transaction that is rolled back when the test ends, whatever the outcome.
 *
 * Why rollback rather than truncation: a test never has to know which tables it
 * touched, nothing is left behind if it throws, and uncommitted rows are
 * invisible to every other connection at Postgres's default isolation, so test
 * files run in parallel against one database without seeing each other.
 *
 * The rollback is forced by throwing a private sentinel out of the interactive
 * transaction after `fn` settles. Prisma rolls back on any throw; the wrapper
 * recognises its own sentinel and swallows it, and rethrows anything else so a
 * failing test still fails.
 *
 * Opening the transaction rides over a dropped loopback connection (see
 * connect-retry.ts): a bounded number of attempts, connectivity failures only.
 */
import type { PrismaClient } from "@prisma/client";
import type { DbClient, RunInTransaction } from "@select-lub/core/db";
import { withConnectionRetry } from "./connect-retry.js";

/** Attempts to open the transaction before a dropped connection fails the test. */
const OPEN_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class RollbackSentinel extends Error {
  constructor() {
    super("test transaction rolled back");
    this.name = "RollbackSentinel";
  }
}

/**
 * Runs `fn` on an open transaction and always rolls it back afterwards.
 *
 * @param prisma - A client that can open transactions (the singleton).
 * @param fn - The test body. Receives the transaction client; everything built
 *   on it (stores, the app) writes inside the transaction.
 * @param options - `timeoutMs` bounds the whole transaction (default 60s), so a
 *   hung test cannot hold row locks forever.
 * @returns Whatever `fn` resolved with. Writes are gone by the time it returns.
 * @throws Whatever `fn` threw, after the rollback.
 */
export async function withTestTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: DbClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const open = () =>
    prisma.$transaction(
      async (tx) => {
        try {
          result = { ok: true, value: await fn(tx) };
        } catch (error) {
          result = { ok: false, error };
        }
        throw new RollbackSentinel();
      },
      { timeout: options.timeoutMs ?? 60_000, maxWait: options.timeoutMs ?? 60_000 },
    );
  try {
    // A dropped connection surfaces before the body runs (Prisma cannot start
    // the interactive transaction), so retrying the open re-runs nothing. The
    // guard makes that explicit: once the body has run, nothing is retried.
    await withConnectionRetry(
      () => (result === undefined ? open() : Promise.reject(new RollbackSentinel())),
      { attempts: OPEN_ATTEMPTS, sleep },
    );
  } catch (error) {
    if (!(error instanceof RollbackSentinel)) throw error;
  }
  if (!result) throw new Error("withTestTransaction: transaction body never ran");
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * The {@link RunInTransaction} to hand adapters built on a test transaction:
 * runs the callback on that same transaction instead of opening a nested one,
 * which Prisma would reject.
 *
 * @param tx - The transaction client from {@link withTestTransaction}.
 * @returns A runner whose writes commit or roll back with the enclosing test.
 */
export function runInTransactionOnTx(tx: DbClient): RunInTransaction {
  return (fn) => fn(tx);
}
