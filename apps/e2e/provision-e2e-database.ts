/**
 * Create, migrate and seed the dedicated e2e database, idempotently.
 *
 * This is the local equivalent of what CI's `playwright` job does inline:
 * `CREATE DATABASE selectlub_e2e`, `db:migrate`, `db:seed`, with `DATABASE_URL`
 * pointing at it. Doing it here rather than in a command a developer has to
 * remember is the point — the reason local runs were intermittently red is that
 * they used whatever database the worktree's `.env` named, and nothing made
 * that wrong loudly.
 *
 * The creation command is the repo's existing one, the same line
 * `worktree-env-plan.ts` prints for a new worktree:
 *   docker compose exec -T postgres psql -U selectlub -d postgres -c 'CREATE DATABASE "<name>"'
 *
 * ORDER. This runs as its own step BEFORE `playwright test`, mirroring CI's
 * "Create selectlub_e2e, migrate, and seed" step. It cannot live in
 * `globalSetup`: Playwright starts `webServer` entries BEFORE globalSetup runs,
 * so the API would boot against a database that does not exist yet and hang on
 * its health check. That was observed, not assumed — the first run on this
 * branch printed `[WebServer] $ tsx watch src/index.ts` while
 * `select datname from pg_database` still showed no e2e database.
 *
 * IDEMPOTENT. `CREATE DATABASE` on an existing database exits non-zero with
 * `already exists`; that specific failure is success here. Any other failure is
 * raised, because "could not reach Postgres" must not read the same as
 * "already provisioned" — that is the shape of hiding a broken setup behind a
 * green run.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  databaseIsProvidedByCi,
  deriveE2eDatabaseName,
  deriveToursDatabaseName,
  e2eDatabaseUrl,
  toursDatabaseUrl,
} from "./e2e-database.js";

/**
 * On Windows `pnpm` is `pnpm.cmd`, and Node refuses to spawn a `.cmd` without a
 * shell. `docker` is a real executable and needs no such help — which is lucky,
 * because it is the call carrying a SQL statement full of spaces.
 */
const PNPM_NEEDS_SHELL = process.platform === "win32";

/**
 * Runs a command, returning its combined output and never throwing.
 *
 * SHELL. Per call, never blanket. `execFileSync` with `shell: true` joins the
 * arguments into one command line WITHOUT quoting them, so any argument
 * containing a space is re-split by the shell: `-c 'CREATE DATABASE "x"'`
 * arrived at psql as three arguments and ran the statement `CREATE`. Callers
 * pass `shell` only for a Windows `.cmd` shim, which cannot be spawned without
 * one, and only when every argument is space-free.
 *
 * @param file - Executable to run.
 * @param args - Arguments. Must contain no spaces when `shell` is true.
 * @param env - Environment for the child.
 * @param shell - Whether to go through a shell; see SHELL above.
 * @returns Exit status and output, so the caller decides what a failure means.
 */
function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shell = false,
): { ok: boolean; output: string } {
  if (shell && args.some((argument) => /\s/.test(argument))) {
    throw new Error(`run(${file}): shell mode cannot carry an argument with a space`);
  }
  try {
    const output = execFileSync(file, args, {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
    });
    return { ok: true, output };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${shaped.stdout ?? ""}${shaped.stderr ?? ""}${shaped.message ?? ""}`,
    };
  }
}

/**
 * Ensures the dedicated e2e database exists, is migrated and is seeded.
 *
 * @param cwd - Repository root to run the workspace commands from.
 * @param stack - Which dedicated database: the e2e suite's, or the tours' own
 *   (`--tours`; see `deriveToursDatabaseName` for why they are apart).
 * @returns The connection string the stack should use.
 * @throws When Postgres is unreachable, or migrate or seed fails.
 */
export function provisionE2eDatabase(cwd: string, stack: "e2e" | "tours" = "e2e"): string {
  const databaseName = stack === "tours" ? deriveToursDatabaseName(cwd) : deriveE2eDatabaseName(cwd);
  const databaseUrl = stack === "tours" ? toursDatabaseUrl(cwd) : e2eDatabaseUrl(cwd);

  const created = run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "selectlub",
      "-d",
      "postgres",
      "-c",
      `CREATE DATABASE "${databaseName}"`,
    ],
    process.env,
  );

  if (!created.ok && !/already exists/i.test(created.output)) {
    throw new Error(
      `e2e database: could not create ${databaseName}. Is Docker running?\n${created.output.trim()}`,
    );
  }

  // Migrate and seed against the dedicated database explicitly, never the
  // inherited DATABASE_URL: these scripts load the repo `.env` when the variable
  // is absent, and that file names the worktree's dev database.
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl };

  const migrated = run("pnpm", ["-w", "db:migrate"], childEnv, PNPM_NEEDS_SHELL);
  if (!migrated.ok) {
    throw new Error(`e2e database: migrate failed on ${databaseName}\n${migrated.output.trim()}`);
  }

  const seeded = run("pnpm", ["-w", "db:seed"], childEnv, PNPM_NEEDS_SHELL);
  if (!seeded.ok) {
    throw new Error(`e2e database: seed failed on ${databaseName}\n${seeded.output.trim()}`);
  }

  return databaseUrl;
}

/**
 * Run as a step: `tsx provision-e2e-database.ts [--tours]`, before `playwright test`.
 * The seed reads `SEED_USER_A_ID` from the inherited env first, so the tour
 * runner links its local test user by setting it before this runs.
 */
if (process.argv[1]?.endsWith("provision-e2e-database.ts")) {
  if (databaseIsProvidedByCi(process.env)) {
    // Not merely unnecessary: `docker compose` is not how a GitHub Actions
    // service container is reached, so attempting it here fails the job.
    console.log("e2e database: provided by CI, nothing to provision");
  } else {
    const stack = process.argv.includes("--tours") ? "tours" : "e2e";
    const url = provisionE2eDatabase(path.join(import.meta.dirname, "../.."), stack);
    const target = new URL(url);
    console.log(`e2e database: ready at ${target.host}${target.pathname}`);
  }
}
