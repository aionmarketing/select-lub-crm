/**
 * Decide whether the seed may write to the database `DATABASE_URL` names.
 *
 * The decision lives here rather than inline in `prisma/seed.ts` so it can be
 * tested without a database: the seed entry point is a top-level-await script
 * that constructs a Prisma client and calls `process.exit`, so importing it in a
 * test would run the seed. Extracting the decision is the only way to sample it.
 *
 * The seed refuses everything that is not `local`, because it writes the demo
 * dataset by default and upserts on top of whatever rows are already there.
 * Unlike the live-test gate, it has no "not equipped" case worth distinguishing:
 * a seed with nowhere to write is a failure, not a skip.
 *
 * Fails closed. `SEED_ALLOW_REMOTE=1` permits a `remote` target and nothing
 * else — an unset, unparseable, or host-less `DATABASE_URL` refuses even with
 * the override set, because the override says "yes, that host", and those
 * values name no host to say yes to.
 */
import { describeDatabaseTarget, resolveDatabaseTarget, type DatabaseTarget } from "./database-target.js";
import { PRISTINE_BASE_DATABASE } from "./worktree-database.js";

export type SeedPermission =
  | {
      readonly kind: "allowed";
      readonly target: DatabaseTarget;
      /** True when a remote target was permitted by `SEED_ALLOW_REMOTE=1`. */
      readonly overridden: boolean;
      /** Line to print on stdout, so a completed seed states where it wrote. */
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly target: DatabaseTarget;
      /** Block to print on stderr before exiting non-zero. Names what it refused. */
      readonly message: string;
    };

type WritePermissionEnv = {
  readonly DATABASE_URL?: string | undefined;
  readonly SEED_ALLOW_REMOTE?: string | undefined;
};

/**
 * Classify a destructive demo-database command's target.
 *
 * @param env - Environment map. Must be read AFTER the `.env` file is loaded.
 * @param options.command - Printed in every message so the operator sees which command refused.
 * @param options.refusePristine - Seed must refuse the base (cadastro is inherited by every clone).
 *   Live-scrub must not: repo-foundation names scrub as the allowed write that removes real bodies
 *   from the base after import.
 */
function resolveWritePermission(
  env: WritePermissionEnv,
  options: { command: "seed" | "scrub-live"; refusePristine: boolean },
): SeedPermission {
  const target = resolveDatabaseTarget(env);
  const allowRemote = env.SEED_ALLOW_REMOTE === "1";
  const label = options.command;

  if (
    options.refusePristine &&
    (target.kind === "local" || target.kind === "remote") &&
    target.database === PRISTINE_BASE_DATABASE
  ) {
    return {
      kind: "refused",
      target,
      message: [
        `${label}: refusing to seed the pristine conversation base "${target.database}" on ${target.host}.`,
        "That database exists only to hold real conversations for other databases to be",
        "created from, and must stay free of cadastro. The seed decorates conversations",
        "that have no customer, so rows written here are inherited by every database",
        "created from it afterwards and cannot be removed by re-seeding — the only",
        "repair is rebuilding the base. Point DATABASE_URL at a database created from",
        "it instead.",
      ].join("\n"),
    };
  }

  if (target.kind === "local" || (target.kind === "remote" && allowRemote)) {
    const overridden = target.kind === "remote";
    return {
      kind: "allowed",
      target,
      overridden,
      message: `${label}: writing to ${describeDatabaseTarget(target)}${
        overridden ? " (SEED_ALLOW_REMOTE=1)" : ""
      }`,
    };
  }

  const reason =
    target.kind === "remote"
      ? `refusing to ${label === "seed" ? "seed" : "scrub"} the remote database at ${target.host}`
      : `refusing to ${label === "seed" ? "seed" : "scrub"}: ${describeDatabaseTarget(target)}`;

  const purpose =
    label === "seed"
      ? "This seed writes the demo dataset by default and upserts on top of whatever\nrows are already there."
      : "This command deletes live ingest and keeps seeded history.";

  return {
    kind: "refused",
    target,
    message: [
      `${label}: ${reason}.`,
      purpose,
      "Point DATABASE_URL at a local database, or set",
      "SEED_ALLOW_REMOTE=1 if you really mean to run this against that host.",
    ].join("\n"),
  };
}

/**
 * Classify the seed's target and decide whether writing to it is permitted.
 *
 * Pure: reads only the passed environment map, opens no connection, and prints
 * nothing. The caller does the printing and the exiting.
 *
 * @param env - Environment map. Must be read AFTER the `.env` file is loaded,
 *   or a perfectly good local target looks absent.
 * @returns `allowed` with the line to log, or `refused` with the block to log.
 */
export function resolveSeedPermission(env: WritePermissionEnv = process.env): SeedPermission {
  return resolveWritePermission(env, { command: "seed", refusePristine: true });
}

/**
 * Same host refusals as the seed; the pristine conversation base is allowed.
 *
 * Scrub is the documented write that strips live bodies from the base after
 * import. Cadastro still cannot land there because {@link resolveSeedPermission}
 * refuses it.
 *
 * @param env - Environment map after `.env` is loaded.
 */
export function resolveScrubLivePermission(env: WritePermissionEnv = process.env): SeedPermission {
  return resolveWritePermission(env, { command: "scrub-live", refusePristine: false });
}
