/**
 * Decide whether a database-writing test suite may run.
 *
 * These suites write to a real database, so pointing them at the wrong one is
 * destructive rather than merely wrong. The gate distinguishes two situations
 * that `Boolean(process.env.DATABASE_URL)` collapsed into one:
 *
 * - `DATABASE_URL` unset — the environment is not equipped to run live tests.
 *   Returns false; the suite skips, which is the long-standing behaviour and is
 *   honest, because nothing was misconfigured.
 *
 * - `DATABASE_URL` set but not loopback — the environment IS equipped and is
 *   aimed at the wrong database. Throws. A skip here would turn the most likely
 *   misconfiguration in this repo (the main checkout's .env names the hosted
 *   instance) into a green run that proves nothing, in exactly the case where
 *   someone most needs to be told.
 *
 * Throwing from module scope fails the importing file and only that file, so the
 * suites that touch no database still run and report normally.
 */
import { describeDatabaseTarget, resolveDatabaseTarget } from "./database-target.js";

export class RemoteDatabaseTestTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteDatabaseTestTargetError";
  }
}

/**
 * @returns true when the suite should run, false when it should skip.
 * @throws {RemoteDatabaseTestTargetError} when DATABASE_URL names a non-loopback
 *   host and `LIVE_TESTS_ALLOW_REMOTE` is not `1`; or when DATABASE_URL is set
 *   but unusable, which throws unconditionally. The override says "yes, that
 *   host", so it has nothing to permit for a value that names no host — the
 *   same split the seed guard makes.
 */
export function shouldRunLiveTests(
  env: {
    readonly DATABASE_URL?: string | undefined;
    readonly LIVE_TESTS_ALLOW_REMOTE?: string | undefined;
  } = process.env,
): boolean {
  const target = resolveDatabaseTarget(env);

  switch (target.kind) {
    case "local":
      return true;
    case "absent":
      return false;
    case "remote":
      if (env.LIVE_TESTS_ALLOW_REMOTE === "1") return true;
      throw new RemoteDatabaseTestTargetError(
        [
          `Refusing to run database-writing tests against ${target.host}.`,
          "These suites create and delete rows. Point DATABASE_URL at a local",
          "database, or set LIVE_TESTS_ALLOW_REMOTE=1 if this really is a",
          "disposable test database.",
        ].join(" "),
      );
    case "unparseable":
      throw new RemoteDatabaseTestTargetError(
        `Refusing to run database-writing tests: ${describeDatabaseTarget(target)}. ` +
          "Unset DATABASE_URL to skip these suites, or set it to a local database to run them.",
      );
  }
}
