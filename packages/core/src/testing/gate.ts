/**
 * `describe` for suites that write to a real database, gated the way every
 * other database-writing suite in this repository is gated.
 *
 * The rule (openspec/specs/repo-foundation, "Database-writing tests require a
 * local target") distinguishes an absent capability from a wrong configuration:
 * no connection string means skip; a non-loopback host means FAIL naming the
 * host, because a skip there turns the most likely misconfiguration into a
 * green run. This wrapper reuses {@link shouldRunLiveTests} so "local" keeps
 * one definition.
 *
 * `DATABASE_URL_TEST` takes precedence over `DATABASE_URL` so a developer's
 * primary connection string is never what a test suite writes to; CI sets both
 * to the same provisioned database.
 */
import { describe } from "vitest";
import { shouldRunLiveTests } from "@select-lub/core/db";

/** The environment names the gate reads. */
export type DatabaseTestEnv = {
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_URL_TEST?: string | undefined;
  readonly LIVE_TESTS_ALLOW_REMOTE?: string | undefined;
};

/**
 * Resolves the connection string a database-writing suite should use.
 *
 * @returns `DATABASE_URL_TEST` when set, else `DATABASE_URL`, else undefined.
 */
export function testDatabaseUrl(env: DatabaseTestEnv = process.env): string | undefined {
  return env.DATABASE_URL_TEST || env.DATABASE_URL || undefined;
}

/**
 * Whether a database-writing suite runs, skips, or is refused.
 *
 * @returns true to run, false to skip.
 * @throws {RemoteDatabaseTestTargetError} when the resolved target is a
 *   non-loopback host and `LIVE_TESTS_ALLOW_REMOTE` is not `1`.
 */
export function shouldRunDatabaseTests(env: DatabaseTestEnv = process.env): boolean {
  return shouldRunLiveTests({
    DATABASE_URL: testDatabaseUrl(env),
    LIVE_TESTS_ALLOW_REMOTE: env.LIVE_TESTS_ALLOW_REMOTE,
  });
}

/**
 * `describe` that runs its suite only when a local database is configured,
 * reports it as skipped when none is, and throws (failing the file) when the
 * configured database is remote.
 *
 * @param name - Suite name, as for `describe`.
 * @param fn - Suite body, as for `describe`.
 * @param env - Environment to resolve against; defaults to `process.env`.
 */
export function describeWithDatabase(
  name: string,
  fn: () => void,
  env: DatabaseTestEnv = process.env,
): void {
  describe.skipIf(!shouldRunDatabaseTests(env))(name, fn);
}
