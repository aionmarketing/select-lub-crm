/**
 * The dedicated local database the e2e and tour stacks run against.
 *
 * WHY THIS EXISTS. CI's `playwright` job creates `selectlub_e2e`, migrates and
 * seeds it, and points `DATABASE_URL` at it, which is why CI stays green while
 * `pnpm test:e2e` is intermittently red locally. Locally the suites have been
 * pointed at the worktree's own dev database — the one holding demo data, the
 * one a `pnpm dev` API is writing to, and the one `pnpm dev:worker` drains the
 * outbox of. The distinguishing property is not the contents: it is that the
 * database is dedicated, with nothing else writing to it while the suite runs.
 *
 * NAMING. Derived per worktree rather than a fixed `selectlub_e2e`, because two
 * worktrees running e2e at the same time would otherwise collide with each
 * other — the same failure one level up. `deriveWorktreeDatabaseName` is the
 * repo's existing convention for exactly this, so the name is its output with
 * an `_e2e` suffix. The main checkout and each worktree therefore get their own.
 *
 * STILL LOCAL. `assertSeedTargetIsLocal` is unchanged and still refuses anything
 * that is not loopback: this endpoint is `127.0.0.1:5433`, so a dedicated
 * database is a local database and the guard passes on its own terms rather
 * than by exception.
 */
import { basename } from "node:path";
import {
  buildLocalDatabaseUrl,
  deriveWorktreeDatabaseName,
} from "@select-lub/core/db";

/** Suffix marking a database as the e2e stack's, never the worktree's dev one. */
export const E2E_DATABASE_SUFFIX = "_e2e";

/**
 * Names the dedicated e2e database for a checkout.
 *
 * @param checkoutDirectory - Absolute path of the repository root in use.
 * @returns The database name, e.g. `selectlub_cursor_redesign_e2e`.
 */
export function deriveE2eDatabaseName(checkoutDirectory: string): string {
  return `${deriveWorktreeDatabaseName(basename(checkoutDirectory))}${E2E_DATABASE_SUFFIX}`;
}

/**
 * The connection string the e2e stack must use.
 *
 * Built rather than derived from the inherited `DATABASE_URL` on purpose: the
 * main checkout's `.env` has pointed at the hosted database before now, and
 * swapping only the database name out of such a URL would leave the suite
 * aimed at a remote host with a local-looking name — the isolation silently
 * absent, which is the failure mode this module exists to remove.
 *
 * @param checkoutDirectory - Absolute path of the repository root in use.
 * @returns A loopback connection string for the dedicated database.
 */
export function e2eDatabaseUrl(checkoutDirectory: string): string {
  return buildLocalDatabaseUrl(deriveE2eDatabaseName(checkoutDirectory));
}

/** Suffix marking a database as the tour stack's, apart from the e2e one. */
export const TOURS_DATABASE_SUFFIX = "_tours";

/**
 * Names the dedicated tour database for a checkout.
 *
 * Its own database, not the e2e one, since tours-local-supabase: the tours
 * sign in as a local test user, `db:seed` writes that user's CRM row under
 * `SEED_USER_A_ID` with a fixed, unique email, and `pnpm test:e2e` writes the
 * hosted attendant's row with the SAME email under a different id. Sharing one
 * database made whichever suite ran second fail its seed on `user.email`.
 *
 * @param checkoutDirectory - Absolute path of the repository root in use.
 * @returns The database name, e.g. `selectlub_cursor_redesign_tours`.
 */
export function deriveToursDatabaseName(checkoutDirectory: string): string {
  return `${deriveWorktreeDatabaseName(basename(checkoutDirectory))}${TOURS_DATABASE_SUFFIX}`;
}

/**
 * The connection string the tour stack must use; see {@link e2eDatabaseUrl}
 * for why it is built rather than derived.
 *
 * @param checkoutDirectory - Absolute path of the repository root in use.
 * @returns A loopback connection string for the dedicated tour database.
 */
export function toursDatabaseUrl(checkoutDirectory: string): string {
  return buildLocalDatabaseUrl(deriveToursDatabaseName(checkoutDirectory));
}

/**
 * Whether the environment already hands the suite a dedicated database.
 *
 * CI's `playwright` job creates `selectlub_e2e` against its postgres SERVICE
 * container (`docker exec <service-id>`), migrates and seeds it, and passes
 * `DATABASE_URL` in the job environment. That is the arrangement this module
 * reproduces locally, so under CI there is nothing to add and two things to
 * avoid: provisioning would shell out to `docker compose`, which no CI runner
 * has, and overriding `DATABASE_URL` would swap CI's correct `selectlub_e2e`
 * for a name derived from the runner's checkout directory, which does not
 * exist. Both broke the `playwright` job on the first push of this branch.
 *
 * @param env - Environment to read, so the rule is testable without mutating
 *   the real `process.env`.
 * @returns True when the caller must leave the database alone.
 */
export function databaseIsProvidedByCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI);
}
