/**
 * Applies `db/grants.generated.sql`: creates the eleven `module_<name>` roles and
 * their grants. Idempotent, so it is safe to apply on every run.
 *
 * Shared by `db:migrate` (after `prisma migrate deploy`) and `db:reconcile-returns`,
 * which needs the grants BEFORE a migration has succeeded: the
 * one-open-return-per-vehicle migration can refuse to apply, and `db:migrate`
 * stops at that failure, before its own grants step (owner rulings, 2026-09-25).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

/** The generated grants file, from the repository root. */
export const GRANTS_PATH = resolve(import.meta.dirname, "../../../../../db/grants.generated.sql");

/**
 * Applies the module roles and grants to the database at `connectionString`.
 *
 * @param connectionString - The database to grant on.
 * @throws When the connection or the SQL fails.
 */
export async function applyModuleGrants(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(readFileSync(GRANTS_PATH, "utf8"));
  } finally {
    await client.end();
  }
}
