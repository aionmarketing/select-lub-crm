/**
 * Startup guard: the API does not start without a database.
 *
 * Before openspec/changes/route-tests-on-real-database, `buildApp` fell back to
 * in-memory stores whenever `DATABASE_URL` was unset, so a misconfigured deploy
 * would come up, answer `/health` with `status: "ok"`, and serve nothing real.
 * The requirement "The API does not start without a database" replaces that
 * with a refusal that names the setting.
 */

/** The single setting the API needs to be backed by a database. */
export const DATABASE_URL_SETTING = "DATABASE_URL";

/**
 * Throws when the database connection setting is absent or blank.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws {Error} whose message names {@link DATABASE_URL_SETTING}.
 */
export function assertDatabaseConfigured(env: { readonly DATABASE_URL?: string | undefined } = process.env): void {
  if (!env.DATABASE_URL || env.DATABASE_URL.trim() === "") {
    throw new Error(
      `${DATABASE_URL_SETTING} is not set. The API does not start without a database; ` +
        "there is no in-memory fallback. Set it to a Postgres connection string.",
    );
  }
}
