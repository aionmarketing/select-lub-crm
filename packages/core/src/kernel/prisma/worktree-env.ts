/**
 * Give the current git worktree its own .env pointing at its own database.
 *
 * Run from inside a worktree: `pnpm db:worktree-env`.
 *
 * Worktrees are isolated in git but not in data — they have no .env of their
 * own, so whoever needs one copies the main checkout's, and every worktree then
 * writes the same database. This copies that .env but rewrites the keys that
 * name a database, so the credentials and configuration come across while the
 * data does not.
 *
 * Deliberately does not create the database or run migrations: those need
 * Docker and Prisma, and a script that half-succeeds across three tools is
 * harder to reason about than one that prints the two commands to run next.
 *
 * What is left here is only the parts that cannot be tested without a second
 * worktree: the git calls, the filesystem, and the printing. Which of the three
 * guards refuses, and what each of them says, is decided by `planWorktreeEnv`
 * in ./worktree-env-plan.ts and sampled in its test.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteEnvForWorktree } from "./worktree-database.js";
import { planWorktreeEnv, worktreeEnvPaths } from "./worktree-env-plan.js";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const worktreeRoot = resolve(git("rev-parse", "--show-toplevel"));
// --git-common-dir points at the MAIN checkout's .git even from inside a
// worktree, which is how we find the .env to copy.
const mainRoot = resolve(git("rev-parse", "--git-common-dir"), "..");

const paths = worktreeEnvPaths(worktreeRoot, mainRoot);
const plan = planWorktreeEnv({
  worktreeRoot,
  mainRoot,
  argv: process.argv.slice(2),
  sourceExists: existsSync(paths.sourceEnvPath),
  targetExists: existsSync(paths.targetEnvPath),
});

if (plan.kind === "refused") {
  console.error(plan.message);
  process.exit(1);
}

writeFileSync(
  plan.targetEnvPath,
  rewriteEnvForWorktree(readFileSync(plan.sourceEnvPath, "utf8"), plan.databaseName),
);

console.log(plan.message);
