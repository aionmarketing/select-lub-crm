/**
 * Test design (testing-strategy)
 *
 * Setup: call planWorktreeEnv with literal roots and two booleans. No git, no
 * filesystem, no second worktree — which is the reason the decision was pulled
 * out of the script at all. Paths are built with node:path `join` in both the
 * expectations and the SUT, so the cases hold on Windows and POSIX alike.
 *
 * Oracle:
 *   repo-foundation — "Each worktree resolves to its own database": a git
 *   worktree SHALL resolve to a database distinct from every other worktree on
 *   the same machine, and worktrees SHALL NOT share a single environment file
 *   for database connection settings. That requirement is the oracle for the
 *   main-checkout guard (writing there would repoint the file every OTHER
 *   checkout copies from), for the target path being inside the worktree, and
 *   for two worktrees deriving different database names.
 *
 *   The other two guards — refusing when the main checkout has no .env, and
 *   refusing to replace an existing worktree .env without --force — have no
 *   OpenSpec scenario. Their oracle is this module's documented contract: the
 *   script "copies it rather than inventing credentials", and an existing .env
 *   "may hold edits this script cannot know about". Named here rather than
 *   claimed as spec-derived. (repo-foundation's ban on inventing an oracle is
 *   written for UI decisions; these are not, and both rules predate this test
 *   rather than being read back off a run.)
 *
 * Partitions (one numbered group = inputs the plan treats the same):
 *
 *   P1 MAIN CHECKOUT  — worktreeRoot === mainRoot
 *   P2 NO SOURCE      — a real worktree, but the main checkout has no .env
 *   P3 TARGET/KEEP    — the worktree already has a .env and --force is absent
 *   P4 TARGET/FORCE   — the worktree already has a .env and --force is present
 *   P5 CLEAN          — a real worktree, source present, no target yet
 *
 * Output partitions:
 *   O1 — refused "main-checkout" (P1)
 *   O2 — refused "missing-source", naming the path it looked in (P2)
 *   O3 — refused "target-exists", naming the file and the flag that overrides
 *        the refusal, so the operator is not left guessing (P3)
 *   O4 — write, replacing false, target inside the WORKTREE (P5)
 *   O5 — write, replacing true (P4)
 *
 * Limits: the flag is exactly "--force". A near-miss ("-force", "--Force",
 * "force") must leave P3 refused — the failure mode here is silent and
 * permanent, since a typo'd flag string makes the command refuse forever with a
 * message telling the operator to pass the flag they are already passing.
 *
 * Map from each `it` to a partition:
 *
 *   refuses in the main checkout                    — P1 -> O1
 *   refuses in the main checkout before the others  — P1 -> O1 (guard order)
 *   refuses when the source .env is missing         — P2 -> O2
 *   refuses to overwrite without the flag           — P3 -> O3
 *   ignores near-miss spellings of the flag         — P3 -> O3 (limit)
 *   replaces an existing .env with the flag         — P4 -> O5
 *   accepts the flag in any argv position           — P4 -> O5 (limit)
 *   plans the write for a clean worktree            — P5 -> O4
 *   targets the worktree's own .env                 — P5 -> O4 (spec)
 *   gives two worktrees different databases         — P5 -> O4 (spec)
 *   names the same database it will write           — P5 -> O4
 *
 * Decision / branch map of planWorktreeEnv:
 *   D1 worktreeRoot === mainRoot   true: P1          false: P2-P5
 *   D2 !sourceExists               true: P2          false: P3-P5
 *   D3 targetExists && !force      true: P3          false: P4 (right), P5 (left)
 *   D4 argv.includes(FORCE_FLAG)   true: P4          false: P3, P5
 *   No outcome is left one-sided.
 *
 * What would make a test fail:
 *   Deriving the database name from the MAIN checkout's directory instead of
 *   the worktree's, which gives every worktree one database and silently undoes
 *   the isolation the requirement exists to create. Writing the target into the
 *   main checkout, which overwrites the file every other worktree copies from.
 *   A typo in the flag string, which makes --force a no-op and the overwrite
 *   refusal permanent. Checking the guards in another order, so running in the
 *   main checkout reports a missing .env instead of naming the real mistake.
 *   Printing a CREATE DATABASE instruction for a database other than the one
 *   the written .env points at.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planWorktreeEnv } from "./worktree-env-plan.js";

const MAIN = join("/repo", "select-lub-crm");
const WORKTREE = join(MAIN, ".claude", "worktrees", "session-1-9355ff");

/** A real worktree with the source .env present and no target yet. */
function plan(overrides: Partial<Parameters<typeof planWorktreeEnv>[0]> = {}) {
  return planWorktreeEnv({
    worktreeRoot: WORKTREE,
    mainRoot: MAIN,
    argv: [],
    sourceExists: true,
    targetExists: false,
    ...overrides,
  });
}

/** Same, narrowed to the write variant so a case can read its paths. */
function writePlan(overrides: Partial<Parameters<typeof planWorktreeEnv>[0]> = {}) {
  const result = plan(overrides);
  if (result.kind !== "write") {
    throw new Error(`expected a write plan, got a refusal: ${result.reason}`);
  }
  return result;
}

describe("planWorktreeEnv", () => {
  it("refuses to run in the main checkout", () => {
    const result = plan({ worktreeRoot: MAIN });

    expect(result).toMatchObject({ kind: "refused", reason: "main-checkout" });
    expect(result.message).toContain("not a worktree");
  });

  it("names the main checkout before any other complaint", () => {
    // Guard order is the message's accuracy. With the later guards also
    // failing, reporting "no .env found" would send the operator to create a
    // file when the real mistake is where they are standing.
    const result = plan({ worktreeRoot: MAIN, sourceExists: false, targetExists: true });

    expect(result).toMatchObject({ kind: "refused", reason: "main-checkout" });
  });

  it("refuses when the main checkout has no .env to copy, and says where it looked", () => {
    const result = plan({ sourceExists: false });

    expect(result).toMatchObject({ kind: "refused", reason: "missing-source" });
    expect(result.message).toContain(join(MAIN, ".env"));
  });

  it("refuses to overwrite an existing worktree .env, and names the flag that would", () => {
    const result = plan({ targetExists: true });

    expect(result).toMatchObject({ kind: "refused", reason: "target-exists" });
    expect(result.message).toContain(join(WORKTREE, ".env"));
    expect(result.message).toContain("--force");
  });

  it.each([["-force"], ["--Force"], ["force"], ["--force-write"]])(
    "does not accept %o as the force flag",
    (flag) => {
      // A typo here refuses forever, telling the operator to pass the flag they
      // are already passing.
      expect(plan({ targetExists: true, argv: [flag] })).toMatchObject({
        kind: "refused",
        reason: "target-exists",
      });
    },
  );

  it("replaces an existing worktree .env when --force is passed", () => {
    const result = plan({ targetExists: true, argv: ["--force"] });

    expect(result).toMatchObject({ kind: "write", replacing: true });
  });

  it.each([
    [["--force", "--verbose"]],
    [["--verbose", "--force"]],
  ])("accepts --force at argv position %#", (argv) => {
    expect(plan({ targetExists: true, argv }).kind).toBe("write");
  });

  it("plans the write for a clean worktree", () => {
    const result = writePlan();

    expect(result.replacing).toBe(false);
    expect(result.sourceEnvPath).toBe(join(MAIN, ".env"));
  });

  it("targets the worktree's own .env, not the file every worktree copies from", () => {
    // Writing to the main checkout's .env would repoint every OTHER checkout,
    // which is the opposite of the isolation this command exists to create.
    const result = writePlan();

    expect(result.targetEnvPath).toBe(join(WORKTREE, ".env"));
    expect(result.targetEnvPath).not.toBe(join(MAIN, ".env"));
  });

  it("gives two worktrees under one checkout two different databases", () => {
    const a = writePlan({ worktreeRoot: join(MAIN, ".claude", "worktrees", "session-1-9355ff") });
    const b = writePlan({ worktreeRoot: join(MAIN, ".claude", "worktrees", "session-2-0233b1") });

    expect(a.databaseName).not.toBe(b.databaseName);
  });

  it("tells the operator to create the same database the .env will point at", () => {
    const result = writePlan();

    expect(result.message).toContain(`CREATE DATABASE "${result.databaseName}"`);
  });
});
