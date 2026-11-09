import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "../../vitest.shared.js";

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      environment: "node",
      env: {
        OMIE_MOCK_DATASET: "",
        // Background oil research never runs under test, whatever the developer's `.env`
        // enables: `startWorker` registers no research job, and no port has a key to reach OpenAI
        // or the Tecfil picker with (background-oil-research D21).
        OIL_RESEARCH_ENABLED: "false",
        OPENAI_API_KEY: "",
      },
      // The live database is migrated and seeded once for the whole run by the
      // ROOT config's `globalSetup`, not here. See the note in
      // `vitest.config.ts`; the `*.live.test.ts` files here do none of it.
    },
  }),
);
