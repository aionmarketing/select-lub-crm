import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.js";

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      environment: "node",
      setupFiles: ["./test/helpers/env.ts"],
      // The live database is migrated and seeded once for the whole run by the
      // ROOT config's `globalSetup`, not here — a per-project hook still seeds
      // while another project is mid-test. See the note in `vitest.config.ts`.
      // The `*.live.test.ts` files in this package therefore do none of it.
    },
  }),
);
