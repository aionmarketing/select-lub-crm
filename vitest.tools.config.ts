import { defineConfig, mergeConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.js";

/**
 * Repo-root tooling tests: scripts that drive the repository itself rather than
 * any one workspace package (today, `fly-deploy.mjs`). The single `*` keeps the
 * glob to top-level files, so no package's suite is collected twice.
 */
export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      name: "tools",
      environment: "node",
      include: ["*.test.ts"],
    },
  }),
);
