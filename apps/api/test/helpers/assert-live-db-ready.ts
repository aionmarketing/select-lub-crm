/**
 * Turn "the live-tests gate says run, but the Prisma client is null" into a
 * loud failure instead of a silent skip.
 *
 * `shouldRunLiveTests()` and the `prisma` singleton (both from `@select-lub/core/db`)
 * answer the same underlying question — is `DATABASE_URL` usable? — with two
 * different predicates: the gate validates the host, the client only checks
 * truthiness at import time. They are expected to agree whenever
 * `shouldRunLiveTests()` returns true. ANDing `prisma !== null` into a suite's
 * "should this run" boolean would let the two predicates diverge into a
 * `describe.skipIf` with no diagnostic — the same silent-skip failure mode
 * openspec/specs/repo-foundation's "Database-writing tests require a local
 * target" requirement exists to remove, just one level narrower. Call this
 * from a `beforeAll` in the Prisma-backed describe block instead, after
 * gating the block on `shouldRunLiveTests()` alone.
 */
export function assertLiveDbReady<T>(prisma: T, suiteName: string): asserts prisma is NonNullable<T> {
  if (prisma === null || prisma === undefined) {
    throw new Error(
      `${suiteName}: shouldRunLiveTests() reported a usable DATABASE_URL, but the ` +
        "@select-lub/core/db prisma client is null. This suite refuses to silently skip " +
        "— check that packages/core/src/kernel/prisma/client.ts observes the same DATABASE_URL as " +
        "live-test-gate.ts before this file's imports run.",
    );
  }
}
