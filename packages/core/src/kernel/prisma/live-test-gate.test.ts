/**
 * Test design (testing-strategy)
 *
 * Setup: call shouldRunLiveTests with an explicit env object. Never reads
 * process.env and never opens a connection, so these cases are identical on a
 * developer machine and in CI.
 *
 * Spec rule (isolate-and-guard-database-targets):
 *   Database-writing suites SHALL distinguish an absent capability from a wrong
 *   configuration, and SHALL NOT report a passing run in either case without
 *   having run. Unset skips; non-loopback FAILS naming the host;
 *   LIVE_TESTS_ALLOW_REMOTE=1 permits a disposable remote test database.
 *
 * Partitions (one numbered group = inputs the spec treats the same):
 *
 *   P1 ABSENT       — DATABASE_URL unset or blank: not equipped
 *   P2 LOCAL        — loopback host: correct target
 *   P3 REMOTE       — non-loopback, no override: equipped but wrong
 *   P4 REMOTE+ALLOW — non-loopback with LIVE_TESTS_ALLOW_REMOTE=1
 *   P5 UNPARSEABLE  — set but unreadable: equipped but unusable
 *   P6 UNPARSEABLE+ALLOW — unreadable WITH LIVE_TESTS_ALLOW_REMOTE=1
 *
 * Output partitions:
 *   O1 — returns false, so the caller skips (P1)
 *   O2 — returns true, so the caller runs (P2, P4)
 *   O3 — throws, naming the host it refused (P3)
 *   O4 — throws (P5, P6)
 *
 * Limits: the override is exactly "1". Any other value ("true", "yes", "0", "")
 * must not enable a remote run, because a guard that accepts near-misses is one
 * a typo can switch off. The override is also scoped to a NAMED non-loopback
 * host: repo-foundation grants it for "a non-loopback target that is genuinely
 * a disposable test database", mirroring the seed guard, and an unreadable
 * value names no target for it to permit.
 *
 * Map from each `it` to a partition:
 *
 *   skips when DATABASE_URL is unset/blank        — P1 -> O1
 *   runs against a loopback host                  — P2 -> O2
 *   throws for a remote host, naming it           — P3 -> O3
 *   runs against remote with the override         — P4 -> O2
 *   ignores near-miss override values             — P3 -> O3 (limit)
 *   throws for an unreadable DATABASE_URL         — P5 -> O4
 *   throws for an unreadable one despite override — P6 -> O4
 *
 * Decision / branch map of shouldRunLiveTests:
 *   switch target.kind    local: P2  absent: P1  remote: P3, P4  unparseable: P5, P6
 *   LIVE_TESTS_ALLOW_REMOTE === "1"  true: P4    false: P3
 *     (P6 reaches the unparseable arm with the override set, which is how the
 *     scope of that override is pinned; the arm itself has no decision.)
 *   No outcome is left one-sided.
 *
 * What would make a test fail:
 *   Returning false for a remote host, i.e. skipping. That is the defect this
 *   gate exists to prevent: the repo's own .env names the hosted instance, so a
 *   silent skip would hide the most likely misconfiguration behind a green run.
 *   Accepting LIVE_TESTS_ALLOW_REMOTE="true" would let a plausible typo disable
 *   the guard. Widening the override to cover an unreadable DATABASE_URL would
 *   let a suite run with nothing to connect to.
 */
import { describe, expect, it } from "vitest";
import { RemoteDatabaseTestTargetError, shouldRunLiveTests } from "./live-test-gate.js";

const LOCAL = "postgresql://selectlub:selectlub@127.0.0.1:5433/selectlub";
const REMOTE = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres";

describe("shouldRunLiveTests", () => {
  it("skips when DATABASE_URL is unset or blank", () => {
    expect(shouldRunLiveTests({})).toBe(false);
    expect(shouldRunLiveTests({ DATABASE_URL: "" })).toBe(false);
  });

  it("runs against a loopback host", () => {
    expect(shouldRunLiveTests({ DATABASE_URL: LOCAL })).toBe(true);
  });

  it("throws for a remote host rather than skipping, and names it", () => {
    // The whole point: a skip here would be a green run that proves nothing.
    expect(() => shouldRunLiveTests({ DATABASE_URL: REMOTE })).toThrow(
      RemoteDatabaseTestTargetError,
    );
    expect(() => shouldRunLiveTests({ DATABASE_URL: REMOTE })).toThrow(
      /db\.example\.supabase\.co/,
    );
  });

  it("runs against a remote host when explicitly allowed", () => {
    expect(shouldRunLiveTests({ DATABASE_URL: REMOTE, LIVE_TESTS_ALLOW_REMOTE: "1" })).toBe(true);
  });

  it.each(["true", "yes", "0", "", "TRUE"])(
    "does not accept %o as the override",
    (value) => {
      expect(() =>
        shouldRunLiveTests({ DATABASE_URL: REMOTE, LIVE_TESTS_ALLOW_REMOTE: value }),
      ).toThrow(RemoteDatabaseTestTargetError);
    },
  );

  it("throws for a DATABASE_URL it cannot read", () => {
    expect(() => shouldRunLiveTests({ DATABASE_URL: "not-a-url" })).toThrow(
      RemoteDatabaseTestTargetError,
    );
  });

  it.each(["not-a-url", "postgresql:///only-a-path"])(
    "still throws for %o even with the override set",
    (value) => {
      // The override permits a NAMED non-loopback host that is a disposable test
      // database (repo-foundation, "mirroring the seed guard's override"). These
      // values name no host, so there is nothing for it to permit, and the
      // unparseable case throws unconditionally. A refactor that hoisted the
      // override above the switch would pass every other case in this file.
      expect(() =>
        shouldRunLiveTests({ DATABASE_URL: value, LIVE_TESTS_ALLOW_REMOTE: "1" }),
      ).toThrow(RemoteDatabaseTestTargetError);
    },
  );
});
