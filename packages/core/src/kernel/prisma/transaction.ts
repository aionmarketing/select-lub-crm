/**
 * The database client shape every store adapter accepts, and the one seam
 * through which an adapter opens a transaction.
 *
 * `DbClient` is Prisma's transaction client: every model delegate plus the raw
 * query methods, minus `$connect`, `$disconnect`, `$on`, `$use`, `$extends` and
 * `$transaction`. A full `PrismaClient` is structurally assignable to it, so an
 * adapter typed this way runs unchanged in production (handed the singleton)
 * and under a test that hands it an already-open transaction.
 *
 * Adapters MUST NOT call `$transaction` on the client directly: Prisma rejects
 * a transaction opened inside another (`Transaction already in progress`), and
 * a test that wraps each case in a rolling-back transaction would hit exactly
 * that. They call the injected {@link RunInTransaction} instead, which in
 * production is `prisma.$transaction` and inside a test transaction is the
 * callback run on the transaction that is already open.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

/** A Prisma client an adapter may be built on: the singleton or an open transaction. */
export type DbClient = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction and resolves with its result.
 *
 * Production: a real transaction that commits when `fn` resolves and rolls back
 * when it throws. Under a test transaction: `fn` runs on the outer transaction,
 * so its writes commit or roll back with the test's, never independently.
 */
export type RunInTransaction = <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;

/**
 * The options every production transaction is opened with.
 *
 * `maxWait` is how long a transaction waits for a pooled connection before it
 * gives up. Prisma's default is 2 s, while a plain query waits for the pool's
 * `pool_timeout`, 10 s by default. A slice issues several short transactions
 * where the old code issued plain queries (reports opens ten at once, and the
 * auth hook one more), so on a small pool the 2 s default turned "waited" into
 * "failed to start". Matching the pool's 10 s keeps the old queuing behaviour.
 *
 * `timeout` bounds how long a transaction may run once it has a connection. It
 * stays Prisma's 5 s, stated here so the ceiling a slice works under is visible:
 * a slice never awaits a provider inside a transaction.
 */
export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 5_000 } as const;

/**
 * Picks the right {@link RunInTransaction} for a client without the caller
 * having to know which kind it was handed.
 *
 * @param db - The singleton `PrismaClient`, or a transaction client.
 * @returns `db.$transaction` bound to `db` when `db` can open transactions;
 *   otherwise a runner that calls `fn(db)` on the already-open transaction.
 */
export function runInTransactionFor(db: DbClient | PrismaClient): RunInTransaction {
  if (canOpenTransactions(db)) {
    return (fn) => db.$transaction((tx) => fn(tx), TRANSACTION_OPTIONS);
  }
  return (fn) => fn(db);
}

function canOpenTransactions(db: DbClient | PrismaClient): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}
