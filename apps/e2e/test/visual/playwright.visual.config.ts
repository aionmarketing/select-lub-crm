/**
 * Standalone Playwright config for the visual geometry specs.
 *
 * WHY THIS EXISTS, rather than the specs just using `apps/e2e/playwright.config.ts`:
 * that config starts its own web server on port 5173 with `reuseExistingServer: false`.
 * On this machine 5173 is permanently held by an unrelated container, so every run from
 * the shared config fails to boot before a single spec executes. This config starts NO
 * servers and points at one already running, which is also the right shape for these
 * specs — they measure a rendered app and have nothing to set up.
 *
 * The specs are still collected by the shared config — its `testDir` is `./test` and its
 * `testMatch` covers every spec file beneath it — so in CI, where 5173 is free, they run
 * in the normal suite against the servers it starts. Nothing here removes them from that
 * run.
 *
 * Run against an already-running dev server:
 *   VISUAL_BASE_URL=http://127.0.0.1:5199 pnpm --filter @select-lub/e2e exec \
 *     playwright test --config test/visual/playwright.visual.config.ts
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env["VISUAL_BASE_URL"] ?? "http://127.0.0.1:5199",
  },
});
