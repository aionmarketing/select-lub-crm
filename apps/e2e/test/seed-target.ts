/**
 * Target guard for the Playwright fixture seed.
 *
 * `seedE2eFixtures` upserts users, units, customers, conversations and messages
 * and forces the live WhatsApp connection row to CONNECTED. Until this module
 * existed its only guard was `if (!process.env.DATABASE_URL) throw` — the same
 * `Boolean(DATABASE_URL)` mistake that isolate-and-guard-database-targets
 * removed from the vitest suites, still live here. That check passed in exactly
 * the case it needed to stop: the seed module loads the repository-root `.env`
 * when `DATABASE_URL` is unset, and on the owner's machine that file names a
 * hosted database holding real WhatsApp conversations, so the guard saw a set
 * value and waved the writes through.
 *
 * The host predicate is imported from `@select-lub/core/db` rather than rewritten, so
 * "local" keeps one definition in the repository (repo-foundation requirement
 * "Database-writing tests require a local target").
 *
 * The policy — refuse anything that is not loopback unless the refusal is
 * overridden explicitly — is the seed guard's in `packages/core/prisma/seed.ts`,
 * and is spelled out inline below rather than imported. That duplication is
 * scheduled, not accidental: the same rule is being extracted as
 * `resolveSeedPermission` in `@select-lub/core/db`, and this module collapses onto it
 * once that lands. Importing it today would mean importing a symbol that does
 * not exist yet.
 *
 * What is NOT duplicated, and must never be, is the host predicate — that stays
 * `resolveDatabaseTarget`'s, imported below.
 *
 * The policy also differs from `shouldRunLiveTests` on one case, deliberately —
 * see {@link assertSeedTargetIsLocal}.
 */
import {
  describeDatabaseTarget,
  resolveDatabaseTarget,
  type DatabaseTarget,
} from "@select-lub/core/db";

/** Raised when the seed refuses to write, whatever the reason. Never thrown for a loopback target. */
export class SeedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedTargetError";
  }
}

/** The slice of the environment the guard reads. Injected in tests; defaults to `process.env`. */
export type SeedTargetEnv = {
  readonly DATABASE_URL?: string | undefined;
  readonly LIVE_TESTS_ALLOW_REMOTE?: string | undefined;
};

/**
 * Decide whether the Playwright fixture seed may write, and to where.
 *
 * Fails closed on every non-loopback outcome.
 *
 * DELIBERATE ASYMMETRY — do not "fix" this into agreement with the vitest gate.
 * An absent `DATABASE_URL` FAILS here and SKIPS in `shouldRunLiveTests`. Two
 * guards over the same requirement disagreeing on one case looks like drift, so
 * the reasoning is recorded here rather than only in the commit that introduced
 * it. The reason is that the vitest gate's skip is honest only
 * because it has somewhere honest to land: `describe.skipIf` marks the suite as
 * skipped in the report, and the suites that touch no database still run. A
 * Playwright `globalSetup` has neither property. It has no skip channel at all —
 * returning normally means "setup succeeded, now run the specs" — and every e2e
 * spec reads rows this seed writes, so a silent no-op would hand the specs an
 * unseeded database and report whatever came back. That is the outcome the
 * requirement exists to prevent: "SHALL NOT report a passing run ... without
 * having run."
 *
 * @param env - Environment to classify. Defaults to `process.env`.
 * @returns The resolved target, so the caller can name where it is about to write.
 * @throws {SeedTargetError} When the target is absent, unreadable, or a
 *   non-loopback host without `LIVE_TESTS_ALLOW_REMOTE=1`.
 */
export function assertSeedTargetIsLocal(env: SeedTargetEnv = process.env): DatabaseTarget {
  const target = resolveDatabaseTarget(env);

  switch (target.kind) {
    case "local":
      return target;

    case "remote":
      // Mirrors the seed guard's escape hatch, so a genuinely disposable remote
      // database does not force anyone to delete the guard to get work done.
      if (env.LIVE_TESTS_ALLOW_REMOTE === "1") {
        return target;
      }
      throw new SeedTargetError(
        [
          `Refusing to seed Playwright fixtures into the remote database at ${target.host}.`,
          "This seed upserts users, units, customers, conversations and messages, and",
          "forces the WhatsApp connection row to CONNECTED. Point DATABASE_URL at a",
          "local database, or set LIVE_TESTS_ALLOW_REMOTE=1 if this really is a",
          "disposable test database.",
        ].join(" "),
      );

    case "absent":
    case "unparseable":
      throw new SeedTargetError(
        [
          `Refusing to seed Playwright fixtures: ${describeDatabaseTarget(target)}.`,
          "Every e2e spec reads the rows this seed writes, so there is no run to be had",
          "without one. Point DATABASE_URL at a local database.",
        ].join(" "),
      );
  }
}
