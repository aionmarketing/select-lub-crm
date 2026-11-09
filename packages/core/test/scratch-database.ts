/**
 * A throwaway database for a live suite that must commit, beside the shared one.
 *
 * `demo-seed.live.test.ts` measures what the demo seed does to EVERY table, so it
 * cannot run inside the rollback harness, and until the cleanup after wave 5 it
 * committed its fixture into the shared test database: a connection, 24
 * conversations, four units per run, and everything the seed hung off them.
 * Nothing removed them, so a second local root run failed `worker.test`'s backfill
 * precondition. Deleting that fixture afterwards would mean a delete list over
 * most of the schema that rots silently when the seed learns a new table, so the
 * suite gets a database of its own instead: created, migrated and dropped per run.
 *
 * On the same server and with the same credentials as `DATABASE_URL`. The caller
 * runs the loopback check first (`shouldRunLiveTests`), so this never reaches a
 * hosted database.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { describeDatabaseTarget, resolveDatabaseTarget } from "../src/kernel/prisma/database-target.js";
import { withConnectionRetry } from "../src/testing/connect-retry.js";

/** Postgres truncates identifiers longer than this, silently, so names are kept under it. */
const MAX_IDENTIFIER_LENGTH = 63;

/** `pnpm` is a `.cmd` shim on Windows, which `execFile` can start only through a shell. */
const PNPM_NEEDS_SHELL = process.platform === "win32";

/** Attempts for each admin statement, the live clients' budget. */
const ADMIN_ATTEMPTS = 4;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The scratch database's name and connection string, derived from the base URL.
 *
 * Parsed with `URL`, never split on `@` or `/`: a password may contain either.
 *
 * @param baseUrl - The shared database's `DATABASE_URL`.
 * @param suffix - What distinguishes this suite's scratch, e.g. `demo_seed_live`.
 * @returns The scratch name (≤ 63 characters) and its URL, identical to the base
 *   but for the database path.
 */
export function scratchDatabaseUrl(baseUrl: string, suffix: string): { name: string; url: string } {
  const parsed = new URL(baseUrl);
  const baseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!baseName) {
    throw new Error("scratch database: DATABASE_URL names no database");
  }
  const tail = `_${suffix}`;
  let name = `${baseName}${tail}`;
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    // Keep it unique to the base: a truncated prefix alone could collide between
    // two worktrees whose database names share their first characters.
    const hash = createHash("sha1").update(baseName).digest("hex").slice(0, 8);
    name = `${baseName.slice(0, MAX_IDENTIFIER_LENGTH - tail.length - hash.length - 1)}_${hash}${tail}`;
  }
  const scratch = new URL(parsed.href);
  scratch.pathname = `/${encodeURIComponent(name)}`;
  return { name, url: scratch.href };
}

/**
 * Quotes a Postgres identifier for a DDL statement, which cannot take a bind parameter.
 *
 * @param name - The raw identifier.
 * @returns It in double quotes, with any double quote doubled.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A created, migrated scratch database. */
export type ScratchDatabase = {
  name: string;
  url: string;
  /** Drops it, even while clients are still connected, and closes the admin connection. */
  drop(): Promise<void>;
};

/**
 * Creates the scratch database, migrated with the grants, and returns a handle to drop it.
 *
 * A scratch left by a crashed run is dropped first. If migrating fails after the
 * database exists, it is dropped before the error is rethrown.
 *
 * Refuses, before any connection, a base that is not on this machine — the same
 * `resolveDatabaseTarget` every guard shares — unless `LIVE_TESTS_ALLOW_REMOTE=1`,
 * the live suites' own override. The caller's `shouldRunLiveTests` normally
 * refuses first; this is so a future caller cannot skip it.
 *
 * @param baseUrl - The shared database's `DATABASE_URL`; the admin statements run there.
 * @param suffix - This suite's scratch suffix.
 * @param repoRoot - Where `pnpm -w db:migrate` runs.
 * @param env - Where `LIVE_TESTS_ALLOW_REMOTE` is read; tests inject it.
 * @param options.migrate - False leaves the database empty: no migrations and no
 *   grants, for a suite that migrates it itself. Defaults to true.
 * @returns The scratch's name, URL and `drop`.
 * @throws When the base is absent, unparseable, or remote without the override.
 */
export async function createScratchDatabase(
  baseUrl: string,
  suffix: string,
  repoRoot: string,
  env: { readonly LIVE_TESTS_ALLOW_REMOTE?: string | undefined } = process.env,
  options: { migrate?: boolean } = {},
): Promise<ScratchDatabase> {
  const target = resolveDatabaseTarget({ DATABASE_URL: baseUrl });
  const allowed = target.kind === "local" || (target.kind === "remote" && env.LIVE_TESTS_ALLOW_REMOTE === "1");
  if (!allowed) {
    throw new Error(
      `scratch database: refusing to create a database next to ${describeDatabaseTarget(target)}. ` +
        "Point DATABASE_URL at a local database, or set LIVE_TESTS_ALLOW_REMOTE=1 if this really is a disposable one.",
    );
  }
  const { name, url } = scratchDatabaseUrl(baseUrl, suffix);
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  // CREATE and DROP DATABASE cannot run inside a transaction, and take no bind
  // parameters: each is one autocommit statement on the quoted name, retried only
  // when it never reached the server, as every live client's statements are.
  const run = (sql: string) =>
    withConnectionRetry(() => admin.$executeRawUnsafe(sql), { attempts: ADMIN_ATTEMPTS, sleep: realSleep });
  const drop = async () => {
    try {
      await run(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  };

  try {
    await run(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
    await run(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } catch (error) {
    await admin.$disconnect();
    throw error;
  }

  if (options.migrate === false) {
    return { name, url, drop };
  }
  try {
    await migrate(url, repoRoot);
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, url, drop };
}

/**
 * `pnpm -w db:migrate` against the scratch: `prisma migrate deploy`, then the module grants.
 *
 * The target goes in through `DATABASE_URL` in the child's environment, never on
 * the command line, and `db:migrate`'s own `.env` loading does not override a
 * variable already set. The arguments carry no whitespace, so the Windows shell
 * cannot re-split them; the guard keeps it that way.
 *
 * Asynchronous (the #163 follow-up): the migrate takes seconds, and the
 * synchronous form blocked the test worker's event loop for all of them, so
 * nothing else in that worker — timers, other suites' I/O — could run.
 */
async function migrate(url: string, repoRoot: string): Promise<void> {
  const args = ["-w", "db:migrate"];
  if (PNPM_NEEDS_SHELL && args.some((argument) => /\s/.test(argument))) {
    throw new Error("scratch database: a shell-run argument may not contain whitespace");
  }
  await promisify(execFile)("pnpm", args, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    // Output is captured (execFile pipes by default), so a failure carries it.
    encoding: "utf8",
    shell: PNPM_NEEDS_SHELL,
  });
}
