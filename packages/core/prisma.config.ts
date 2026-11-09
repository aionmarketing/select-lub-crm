/**
 * Prisma CLI configuration for `@select-lub/core` (the schema, migrations and seed
 * under `packages/core/prisma`; formerly `@select-lub/db`).
 *
 * Three reasons this file exists, the first two consequences of the schema
 * becoming multi-file (one `<module>.prisma` per module, per `ownership.json`):
 *
 * 1. **`migrations.path` has to be stated.** With a single `schema.prisma`,
 *    Prisma looks for migrations beside it. With a schema *folder* it looks
 *    inside that folder — so `prisma migrate deploy --schema prisma/schema`
 *    silently found no migrations in `prisma/migrations` and reported "No
 *    pending migrations to apply" against a database with no tables at all.
 *    That is the worst possible failure for a deploy step: green, and nothing
 *    happened. Pointing `migrations.path` at the existing folder keeps all 35
 *    migrations where they are, with their history and their hashes intact.
 *
 * 2. **`package.json#prisma` is deprecated** and removed in Prisma 7; the CLI
 *    warns on every invocation. The `seed` entry moves here unchanged.
 *
 * 3. **A Prisma config turns OFF the CLI's own `.env` loading** — it says so on
 *    every run ("Prisma config detected, skipping environment variable
 *    loading"). Without the block below, a developer running `prisma migrate
 *    status` or `prisma migrate dev` in a worktree would suddenly get no
 *    `DATABASE_URL`, even though `db:worktree-env` had just written one. So the
 *    config loads it the same way `src/migrate-deploy.ts` does, and only when
 *    the file exists — CI has no `.env` and supplies the variable through the
 *    job environment, which is left untouched here.
 *
 * With this file the `--schema` flag is redundant, but every call still passes
 * it: `prisma.config.ts` is resolved from the working directory, and the calls
 * that run from the repository root rather than from `packages/core` would
 * otherwise pick up no config at all.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

const envPath = path.resolve(import.meta.dirname, "../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
    // Prisma runs this by itself after `prisma migrate reset` (and a reset
    // `migrate dev`), which re-creates the tables WITHOUT the module grants that
    // `db:migrate` applies; the seed's vehicle returns run under module roles, so
    // a bare `tsx prisma/seed.ts` here would fail with "permission denied". The
    // root script re-applies the grants (the migrate itself is then a no-op),
    // then seeds. Prisma runs the command without a shell, hence a pnpm script
    // for the `&&`.
    seed: "pnpm -w db:migrate-then-seed",
  },
});
