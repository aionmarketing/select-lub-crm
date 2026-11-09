/**
 * One migrate-and-seed for the whole test run, instead of one per test file.
 *
 * Wired as `globalSetup` in the ROOT `vitest.config.ts`, not per project. Both
 * matter: once per project still leaves two projects seeding as they start,
 * which is exactly while `packages/core/test/demo-seed.live.test.ts` is creating
 * fixtures and measuring what a seed does to them.
 *
 * THE PROBLEM THIS REPLACES. Eleven `*.live.test.ts` files across `apps/api` and
 * `apps/worker` each ran `pnpm db:migrate && pnpm db:seed` in their own
 * `beforeAll`. Vitest runs files in parallel, so those seven spawned processes
 * wrote to the same Postgres at the same time, and Prisma's `upsert` is
 * select-then-insert rather than atomic: two seeds both read "this row is
 * absent", both insert, and the loser dies on a unique constraint. The hook
 * throws, so the whole file fails before a single test runs — which is why the
 * failures showed as "N tests | N skipped" with the file red, and why the set of
 * failing files changed between identical runs while each passed alone.
 * Recorded as HANDOFF.md item 5, whose own suggestion this implements.
 *
 * WHY ONCE IS ENOUGH. The seed is idempotent by construction, so eleven runs of
 * it produced the same database as one — the repetition bought nothing but the
 * race. Vitest runs `globalSetup` a single time in the main process before any
 * worker starts, which is the one place a shared resource can be prepared
 * without coordination.
 *
 * WHAT IT DOES NOT FIX. Concurrency *between* Vitest projects, or between a
 * suite and another session's run on the same database. Nothing here makes the
 * database exclusive; it removes the self-inflicted collision only.
 *
 * @module
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { shouldRunLiveTests } from "./live-test-gate.js";

const execAsync = promisify(exec);

/**
 * Repo root, from this file's location inside `packages/core/src/kernel/prisma`.
 *
 * Resolved rather than passed in so every caller cannot get it subtly wrong;
 * `globalSetup` runs with the project directory as cwd, not the repo root.
 */
const repoRoot = resolve(import.meta.dirname, "../../../../..");

/**
 * In-process guard, so a caller that invokes this twice pays for it once.
 *
 * Belt and braces next to `globalSetup`, which already runs once: the export is
 * usable from a `beforeAll` too, and there it matters.
 */
let inFlight: Promise<void> | undefined;

/**
 * Brings the live-test database up to date, at most once per process.
 *
 * A no-op unless {@link shouldRunLiveTests} passes, so a machine with no
 * `DATABASE_URL` — or one pointed at a remote host without the explicit
 * override — pays nothing and stays green. That check is what lets this be
 * wired unconditionally as a project's `globalSetup`.
 *
 * Never throws. A `DATABASE_URL` that looks local says nothing about whether
 * that database is reachable, and failing here would fail `globalSetup`, which
 * fails the entire run — thousands of tests that never open a connection
 * included. A database that cannot be prepared is left for the live tests that
 * actually need one to report.
 *
 * @returns Resolves once migrate and seed have completed, or once the attempt
 *   has been given up on and warned about.
 */
export async function seedLiveDatabaseOnce(): Promise<void> {
  const envPath = resolve(repoRoot, ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
  if (!shouldRunLiveTests()) return;

  inFlight ??= (async () => {
    try {
      await execAsync("pnpm db:migrate", {
        cwd: repoRoot,
        env: process.env,
      });
      await execAsync("pnpm db:seed", {
        cwd: repoRoot,
        env: process.env,
      });
    } catch (error) {
      // Warn and continue, never abort the run. `shouldRunLiveTests()` passes on
      // a local-looking `DATABASE_URL`, which says nothing about whether that
      // database is actually reachable — and on 2026-09-11 it was not, because
      // Docker Desktop stopped and took the Compose Postgres on 5433 with it.
      // Throwing here failed `globalSetup`, which failed the WHOLE run: 2,600-odd
      // tests that never open a connection died for a database they do not use.
      // Before this hook existed, an absent database was contained to the live
      // files that needed one, and that blast radius is the right one to keep.
      // Those files still fail, loudly and for the real reason; everything else
      // still runs.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[live-seed-once] migrate/seed did not complete, continuing anyway. Live tests that need a database will fail on their own.\n${reason}`,
      );
    }
  })();

  return inFlight;
}

/**
 * Vitest `globalSetup` entry point.
 *
 * @returns Resolves once the live database is ready, or immediately when live
 *   tests are not enabled.
 */
export default async function setup(): Promise<void> {
  await seedLiveDatabaseOnce();
}
