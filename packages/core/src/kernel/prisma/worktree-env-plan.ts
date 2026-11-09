/**
 * Decide what `db:worktree-env` should do, without doing any of it.
 *
 * The script itself shells out to git, reads and writes files, and calls
 * `process.exit`, so none of its three refusals could be sampled while they
 * lived inline. They are the whole safety of the command — one of them refuses
 * to overwrite a file it cannot know the contents of — so they are the part
 * that most needs a test. This module holds the decision; `worktree-env.ts`
 * keeps the git calls, the filesystem, and the printing.
 *
 * Pure: no filesystem access, no git, no printing. Whether the two .env files
 * exist is passed in as booleans by the caller that already had to look.
 */
import { basename, join } from "node:path";
import { deriveWorktreeDatabaseName } from "./worktree-database.js";

/** The flag that permits replacing an existing worktree .env. */
export const FORCE_FLAG = "--force";

export type WorktreeEnvPaths = {
  /** The main checkout's .env, which the worktree's copy is made from. */
  readonly sourceEnvPath: string;
  /** Where the rewritten copy goes. */
  readonly targetEnvPath: string;
  /** The per-worktree database the copy will point at. */
  readonly databaseName: string;
};

export type WorktreeEnvPlan =
  | (WorktreeEnvPaths & {
      readonly kind: "write";
      /** True when an existing target is being replaced under `--force`. */
      readonly replacing: boolean;
      /** Block to print on stdout after the write succeeds. */
      readonly message: string;
    })
  | {
      readonly kind: "refused";
      /** Which guard refused, so a caller can branch without matching prose. */
      readonly reason: "main-checkout" | "missing-source" | "target-exists";
      /** Block to print on stderr before exiting non-zero. */
      readonly message: string;
    };

/**
 * Work out the two .env paths and the database name for a worktree.
 *
 * Separate from the plan so the caller can test the two files for existence
 * before asking for a decision about them.
 *
 * @param worktreeRoot - Absolute path to the current worktree's root.
 * @param mainRoot - Absolute path to the main checkout's root.
 */
export function worktreeEnvPaths(worktreeRoot: string, mainRoot: string): WorktreeEnvPaths {
  return {
    sourceEnvPath: join(mainRoot, ".env"),
    targetEnvPath: join(worktreeRoot, ".env"),
    databaseName: deriveWorktreeDatabaseName(basename(worktreeRoot)),
  };
}

/**
 * Decide whether to write the worktree's .env, and what to say either way.
 *
 * @param input.worktreeRoot - Root of the worktree the command was run in.
 * @param input.mainRoot - Root of the main checkout, found via `--git-common-dir`.
 * @param input.argv - Command-line arguments after the script name.
 * @param input.sourceExists - Whether the main checkout's .env exists.
 * @param input.targetExists - Whether this worktree already has a .env.
 * @returns `write` with the paths and the success text, or `refused` with the
 *   guard that refused and the text explaining it.
 */
export function planWorktreeEnv(input: {
  readonly worktreeRoot: string;
  readonly mainRoot: string;
  readonly argv: readonly string[];
  readonly sourceExists: boolean;
  readonly targetExists: boolean;
}): WorktreeEnvPlan {
  const paths = worktreeEnvPaths(input.worktreeRoot, input.mainRoot);
  const force = input.argv.includes(FORCE_FLAG);

  if (input.worktreeRoot === input.mainRoot) {
    return {
      kind: "refused",
      reason: "main-checkout",
      message: [
        "worktree-env: this is the main checkout, not a worktree.",
        "It already owns the .env that worktrees copy from. Run this from inside a",
        "worktree created with `git worktree add`.",
      ].join("\n"),
    };
  }

  if (!input.sourceExists) {
    return {
      kind: "refused",
      reason: "missing-source",
      message: [
        `worktree-env: no .env found at ${paths.sourceEnvPath}.`,
        "Create the main checkout's .env from .env.example first; this script copies",
        "it rather than inventing credentials.",
      ].join("\n"),
    };
  }

  if (input.targetExists && !force) {
    return {
      kind: "refused",
      reason: "target-exists",
      message: [
        `worktree-env: ${paths.targetEnvPath} already exists; refusing to overwrite.`,
        `It may hold edits this script cannot know about. Pass ${FORCE_FLAG} to replace it.`,
      ].join("\n"),
    };
  }

  return {
    ...paths,
    kind: "write",
    replacing: input.targetExists,
    message: [
      `worktree-env: wrote ${paths.targetEnvPath}`,
      `  copied from ${paths.sourceEnvPath}`,
      `  database    ${paths.databaseName}`,
      "",
      "This .env carries the same credentials as the main checkout's. It is",
      "gitignored; keep it that way.",
      "",
      "Next, create that database and migrate it:",
      "",
      `  docker compose exec -T postgres psql -U selectlub -d postgres -c 'CREATE DATABASE "${paths.databaseName}"'`,
      "  pnpm db:migrate",
      "  pnpm db:seed",
      "",
      "The seed now refuses any non-loopback host and prints where it writes.",
    ].join("\n"),
  };
}
