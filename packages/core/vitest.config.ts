import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.js";

/**
 * `@select-lub/core`: the kernel, the shared kernel, and the modules.
 *
 * `test/` holds the three structure checks that keep ownership honest — the
 * generated grants, the schema/ownership agreement, and the role rejection
 * itself. Slice suites live beside their slices under `src/modules/`.
 * `prisma/` holds the demo seed's own tests (from `packages/db`, wave 5.1c); without
 * it in `include` they would stop running without a single failure.
 */
export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      name: "@select-lub/core",
      environment: "node",
      include: ["src/**/*.test.ts", "test/**/*.test.ts", "prisma/**/*.test.ts"],
      // The network backstop (switch-oil-research-to-openai task 1.3): a connection to any
      // non-loopback host — OpenAI, Motul, Tecfil, anything — is refused and fails
      // the test, even when the code under test swallows the error.
      setupFiles: ["./test/network-guard.setup.ts"],
      // The ERP pull's tests build the mock from `process.env`; a developer's
      // `OMIE_MOCK_DATASET=tidsci` would swap in the generated dump and change
      // every expectation. Moved here with those tests from apps/worker (3A).
      env: {
        OMIE_MOCK_DATASET: "",
        // Background oil research never runs under test, whatever the developer's `.env`
        // enables: the switch off, and no key for the research model or the Tecfil picker to reach a provider
        // with (background-oil-research D21).
        OIL_RESEARCH_ENABLED: "false",
        OPENAI_API_KEY: "",
      },
    },
  }),
);
