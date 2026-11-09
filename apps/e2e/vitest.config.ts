import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.js";

/**
 * Vitest project for the few unit-testable helpers that live beside the
 * Playwright suite — today, the fixture seed's database-target guard.
 *
 * `include` is narrowed on purpose. Vitest's default picks up `*.spec.ts` as
 * well as `*.test.ts`, and every `*.spec.ts` in `test/` is a Playwright spec
 * that would fail under Vitest for reasons that have nothing to do with the
 * code under test. Playwright's own config claims `*.spec.ts`; this one claims
 * `*.test.ts`, and the two never overlap.
 */
export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
    },
  }),
);
