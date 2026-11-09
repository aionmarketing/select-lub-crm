/**
 * Oracle: openspec/specs/repo-foundation/spec.md, requirement "Database-writing
 * tests require a local target" — its five scenarios, read as the expected
 * values here. Nothing in this file was derived by running the guard.
 *
 * One deliberate deviation from that requirement's "An absent connection string
 * still skips" scenario: this guard FAILS on an absent DATABASE_URL. The
 * scenario grants a skip to suites that have a skip channel — `describe.skipIf`
 * marks them skipped in the report and leaves the non-database suites running.
 * A Playwright globalSetup has neither: returning normally means "run the
 * specs", and every e2e spec reads rows this seed writes. Skipping there would
 * produce the green-run-that-proves-nothing the requirement exists to forbid, so
 * refusing is how the same principle lands on a component with no skip. See
 * `assertSeedTargetIsLocal`.
 *
 * Env is injected rather than mutated on `process.env`: the guard's own module
 * is imported in isolation precisely so that `seed-e2e.ts` — whose module scope
 * loads the repository-root `.env` — never runs during a unit test.
 *
 * Out of scope: URL parsing itself (passwords containing "@", IPv6 bracket
 * stripping, the loopback host list) is `@select-lub/core/db`'s
 * `database-target.test.ts`; duplicating it here would create the second
 * definition of "local" the requirement forbids.
 */
import { describe, expect, it } from "vitest";
import { LOOPBACK_HOSTS } from "@select-lub/core/db";
import { SeedTargetError, assertSeedTargetIsLocal } from "./seed-target.js";

const REMOTE_URL = "postgresql://user:pw@db.abcdefgh.supabase.co:5432/postgres";

/** Builds a connection string for `host`, bracketing IPv6 the way a real URL must. */
function urlFor(host: string) {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `postgresql://user:pw@${authority}:5432/selectlub`;
}

describe("assertSeedTargetIsLocal", () => {
  it.each(LOOPBACK_HOSTS.map((host) => ({ host })))(
    "returns the local target for $host",
    ({ host }) => {
      const target = assertSeedTargetIsLocal({ DATABASE_URL: urlFor(host) });

      expect(target).toEqual({ kind: "local", host, database: "selectlub" });
    },
  );

  it("refuses a non-loopback host and names it", () => {
    const act = () => assertSeedTargetIsLocal({ DATABASE_URL: REMOTE_URL });

    expect(act).toThrow(SeedTargetError);
    expect(act).toThrow("db.abcdefgh.supabase.co");
  });

  it("allows a non-loopback host when LIVE_TESTS_ALLOW_REMOTE is exactly 1", () => {
    const target = assertSeedTargetIsLocal({
      DATABASE_URL: REMOTE_URL,
      LIVE_TESTS_ALLOW_REMOTE: "1",
    });

    expect(target).toEqual({
      kind: "remote",
      host: "db.abcdefgh.supabase.co",
      database: "postgres",
    });
  });

  // The override is an exact-match escape hatch, not a truthiness check — the
  // defect this whole requirement removes. "0" is the value someone sets to mean
  // "no"; "true" and "" are the near-misses a shell or CI file produces.
  it.each([
    { allow: "0" },
    { allow: "true" },
    { allow: "" },
  ])("still refuses a non-loopback host when LIVE_TESTS_ALLOW_REMOTE is $allow", ({ allow }) => {
    const act = () =>
      assertSeedTargetIsLocal({ DATABASE_URL: REMOTE_URL, LIVE_TESTS_ALLOW_REMOTE: allow });

    expect(act).toThrow(SeedTargetError);
  });

  it.each([
    { label: "unset", env: {} },
    { label: "blank", env: { DATABASE_URL: "" } },
    { label: "whitespace", env: { DATABASE_URL: "   " } },
  ])("refuses to seed when DATABASE_URL is $label", ({ env }) => {
    const act = () => assertSeedTargetIsLocal(env);

    expect(act).toThrow(SeedTargetError);
    expect(act).toThrow("DATABASE_URL is not set");
  });

  it("refuses a DATABASE_URL that is not a readable URL", () => {
    const act = () => assertSeedTargetIsLocal({ DATABASE_URL: "selectlub-local" });

    expect(act).toThrow(SeedTargetError);
    expect(act).toThrow("DATABASE_URL is not a readable URL");
  });

  // Scopes the escape hatch to the one case it is for. If the override were read
  // before the target were classified, an unset or malformed DATABASE_URL plus a
  // stale LIVE_TESTS_ALLOW_REMOTE=1 in someone's shell would seed nothing while
  // reporting success.
  it.each([
    { label: "unset", env: { LIVE_TESTS_ALLOW_REMOTE: "1" } },
    { label: "unreadable", env: { DATABASE_URL: "nope", LIVE_TESTS_ALLOW_REMOTE: "1" } },
  ])("does not let LIVE_TESTS_ALLOW_REMOTE rescue a $label DATABASE_URL", ({ env }) => {
    const act = () => assertSeedTargetIsLocal(env);

    expect(act).toThrow(SeedTargetError);
  });
});
