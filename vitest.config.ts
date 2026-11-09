import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrate and seed the live database exactly ONCE for the whole run, here
    // at the root, before any project starts.
    //
    // It used to happen in eleven `beforeAll` hooks across `apps/api` and
    // `apps/worker`. Vitest runs files — and projects — in parallel against the
    // single local Postgres, and Prisma's `upsert` is select-then-insert, so
    // those seeds raced: two would read "row absent", both insert, and the
    // loser died on a unique constraint, taking its whole file's setup with it.
    // That is HANDOFF.md item 5, and it is why the set of failing files moved
    // between identical runs while each passed alone.
    //
    // Per-project `globalSetup` fixed the collisions but not the timing: two
    // projects still seeded as they started, which is exactly while
    // `packages/core/test/demo-seed.live.test.ts` is creating fixtures and
    // measuring what the seed does to them — a concurrent seed deleted them
    // mid-test. Seeding once, before anything runs, is the only arrangement in
    // which no seed overlaps a test. A no-op when live tests are not enabled.
    //
    // Scope, stated because silence reads as coverage later: this covers SEEDING
    // only. It says nothing about two live test FILES mutating the same tables
    // concurrently — demo-seed.live counting rows while services-vehicle-returns.live
    // creates and deletes them. That is handled separately, by the root `test`
    // script running live files in their own `vitest run --no-file-parallelism`
    // invocation, where the flag applies at root level and actually takes
    // effect. A project-level `fileParallelism: false` does not survive the root's
    // `projects`; `packages/db` carried one, documented as inert, until 5.1c.
    globalSetup: ["./packages/core/src/kernel/prisma/live-seed-once.ts"],

    // `globalSetup` above closed the SEEDING overlap, and only that. Two live files
    // mutating the same tables while both are running is a different mechanism, and it
    // was never addressed -- the note above describes a protection against one race and
    // was read as covering both. Measured: a parallel live run fails inside
    // `seedDemoDataset` with `Foreign key constraint violated on
    // scheduled_message_conversation_id_fkey`, one file writing a row whose conversation
    // another had already deleted. No seed overlapped; the rows were simply shared.
    //
    // That second race is handled by the `test` script, which runs the 17 `*.live.test.ts`
    // files in their own final pass with `--no-file-parallelism`, and excludes them from
    // the pass before it. On the command line the flag applies at root level, so the
    // guarantee holds by construction rather than by a project-level value resolving.
    projects: [
      // Repo-root tooling (fly-deploy.mjs). Its refusals are the only thing
      // standing between a typo and a published link that cannot sign in, so
      // they belong in `pnpm test` rather than in a script nobody exercises.
      "vitest.tools.config.ts",
      "apps/api/vitest.config.ts",
      // apps/e2e is Playwright's, but its fixture seed's database-target guard
      // is plain logic that must not be verified by running the browser suite.
      // That project's `include` claims only *.test.ts; Playwright's testMatch
      // claims *.spec.ts, so the two runners never collide. Note the coverage
      // `exclude` below still lists apps/e2e/** on purpose: these tests run and
      // can fail the build, they just do not report coverage.
      "apps/e2e/vitest.config.ts",
      "apps/web/vitest.config.ts",
      "apps/worker/vitest.config.ts",
      "packages/shared-types/vitest.config.ts",
      "packages/core/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "**/playwright-report/**",
        "**/test-results/**",
        "**/blob-report/**",
        "**/*.{config,workspace}.{js,cjs,mjs,ts}",
        "vitest.shared.ts",
        "**/*.d.ts",
        "**/prisma/migrations/**",
        "**/generated/**",
        "**/node_modules/.prisma/**",
        "apps/e2e/**",
      ],
    },
  },
});
