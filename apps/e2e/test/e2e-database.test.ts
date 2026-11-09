/**
 * Test design (testing-strategy)
 *
 * SUT: `deriveE2eDatabaseName` / `e2eDatabaseUrl` / `databaseIsProvidedByCi` — pure string derivation. No
 *   Postgres, no Playwright, no filesystem. Deliberately runnable with Docker
 *   down, which is the state this landed in.
 *
 * Oracle: the assignment's constraints. The e2e database must be (a) dedicated,
 *   so it is never the worktree's dev database, (b) distinct per worktree, so
 *   two checkouts running e2e at once do not collide with each other, and (c)
 *   still LOCAL, so `assertSeedTargetIsLocal` passes on its own terms rather
 *   than by exception.
 *
 * Axes
 *   A1 checkout directory — main checkout / a worktree / a second worktree
 *   A2 the guard's verdict on the produced URL — loopback
 *
 * Outputs: O1 a name ending `_e2e`; O2 two different names; O3 the guard accepts
 *
 * Sampled-cell
 *   main checkout            | A1 | O1 | returns the dev database's own name
 *   worktree vs main         | A1 | O2 | both checkouts share one e2e database
 *   worktree vs worktree     | A1 | O2 | two worktrees collide with each other
 *   produced URL             | A2 | O3 | a dedicated database reads as remote
 *
 * Decision / branch map: none — the functions are straight-line. The cases are
 *   the distinctness relation, which is what the constraints actually assert.
 *
 * Out of scope: that the database exists, is migrated, or is seeded — that needs
 *   Postgres and is the half this cannot prove; the provisioning wiring in the
 *   Playwright configs.
 */
import { describe, expect, it } from "vitest";
import { assertSeedTargetIsLocal } from "./seed-target.js";
import {
  databaseIsProvidedByCi,
  deriveE2eDatabaseName,
  E2E_DATABASE_SUFFIX,
  e2eDatabaseUrl,
} from "../e2e-database.js";

const MAIN_CHECKOUT = "C:/Users/grodr/Desktop/select-lub-crm";
const WORKTREE_A = "C:/Users/grodr/Desktop/select-lub-crm/.claude/worktrees/fervent-pascal-6fd1a4";
const WORKTREE_B = "C:/Users/grodr/Desktop/select-lub-crm/.claude/worktrees/active-sessions-a7b368";

describe("the dedicated e2e database name", () => {
  it("is marked as the e2e one, never the checkout's dev database", () => {
    const name = deriveE2eDatabaseName(MAIN_CHECKOUT);

    expect(name.endsWith(E2E_DATABASE_SUFFIX)).toBe(true);
    // The value, not just the suffix: a bug returning the bare worktree name
    // would still end in `_e2e` if the suffix were applied to a constant.
    expect(name).not.toBe(deriveE2eDatabaseName(WORKTREE_A));
  });

  it("differs between a worktree and the main checkout", () => {
    expect(deriveE2eDatabaseName(WORKTREE_A)).not.toBe(deriveE2eDatabaseName(MAIN_CHECKOUT));
  });

  it("differs between two worktrees, which is the collision one level up", () => {
    // Two sessions running e2e in different worktrees at the same time is the
    // same failure this change removes, so it must not be reintroduced by a
    // name that ignores which worktree it was asked about.
    expect(deriveE2eDatabaseName(WORKTREE_A)).not.toBe(deriveE2eDatabaseName(WORKTREE_B));
  });
});

describe("the dedicated e2e connection string", () => {
  it("is loopback, so the seed guard accepts it unchanged", () => {
    // The guard is not relaxed for this database: it passes because a dedicated
    // database on 127.0.0.1 IS local. Asserting through the real guard rather
    // than eyeballing the host is what makes that a fact instead of a claim.
    const target = assertSeedTargetIsLocal({
      DATABASE_URL: e2eDatabaseUrl(MAIN_CHECKOUT),
    });

    expect(target.kind).toBe("local");
  });

  it("names the derived database, not the inherited one", () => {
    expect(e2eDatabaseUrl(MAIN_CHECKOUT)).toContain(deriveE2eDatabaseName(MAIN_CHECKOUT));
  });
});

describe("deferring to a database CI already made", () => {
  // Regression. The first push of this branch broke CI's `playwright` job
  // twice over: the provisioning step shelled out to `docker compose`, which a
  // GitHub Actions service container is not reached through, and the config
  // overrode CI's `DATABASE_URL` with a name derived from the runner's
  // checkout directory, which nothing had created. Both call sites now ask
  // this one question, so this test is what keeps them asking it.
  it("defers when CI is set", () => {
    expect(databaseIsProvidedByCi({ CI: "true" })).toBe(true);
  });

  it("provisions locally, where CI is absent", () => {
    expect(databaseIsProvidedByCi({})).toBe(false);
  });

  it("treats an empty CI as absent, as the shell does", () => {
    expect(databaseIsProvidedByCi({ CI: "" })).toBe(false);
  });
});
