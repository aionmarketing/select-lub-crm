/**
 * CLI entry: runs `prisma migrate deploy` with the process environment (CI/operators, not Fly machines).
 *
 * `--schema prisma/schema` because the schema is multi-file: one `<module>.prisma`
 * per module, per ownership.json. Prisma reads the folder as a single schema.
 *
 * After the migration it applies `db/grants.generated.sql`, which creates the
 * eleven `module_<name>` roles and their grants. It runs here rather than in a
 * migration because it is derived from `ownership.json` rather than from the
 * schema, and because it must be reapplied whenever that file changes — a
 * database migrated before the roles existed would otherwise fail at the first
 * `db.tx` with `permission denied to set role`.
 *
 * Loads the repository root's `.env` (`../../../../../.env` from this file) when present. Forwards stdio to the child process and exits with its status code.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyModuleGrants } from "./apply-grants.js";

const envPath = resolve(import.meta.dirname, "../../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const result = spawnSync("prisma", ["migrate", "deploy", "--schema", "prisma/schema"], {
  stdio: "inherit",
  env: process.env,
  shell: true,
});
if (result.status !== 0) process.exit(result.status ?? 1);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "db:migrate: DATABASE_URL is not set, so the module roles were NOT applied.",
  );
  process.exit(1);
}

try {
  await applyModuleGrants(connectionString);
  console.log("db:migrate: applied db/grants.generated.sql (module roles)");
} catch (error) {
  console.error("db:migrate: applying db/grants.generated.sql failed:", error);
  process.exit(1);
}
