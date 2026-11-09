/**
 * Opt-in Playwright config for live Programar mensagem (real Evolution + worker).
 *
 * Default `playwright.config.ts` must never collect `test/live`. Invoke only via
 * `pnpm test:e2e:live`, which sets `E2E_LIVE_SCHEDULE=1`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const workerPort = Number(env.WORKER_PORT ?? 3001);

export default defineConfig({
  testDir: "./test/live",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @select-lub/api dev",
      cwd: repoRoot,
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...env,
        HOST: "127.0.0.1",
        PORT: "3000",
      },
    },
    {
      command: "pnpm --filter @select-lub/worker dev",
      cwd: repoRoot,
      url: `http://127.0.0.1:${workerPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...env,
        WORKER_HOST: "127.0.0.1",
        WORKER_PORT: String(workerPort),
        // Background oil research stays off here whatever `.env` enables: this worker runs on
        // whatever database `.env` names, and must not research it (background-oil-research D21).
        // The worker's own `.env` load never overrides a variable already set.
        OIL_RESEARCH_ENABLED: "false",
      },
    },
    {
      command: "pnpm --filter @select-lub/web dev",
      cwd: repoRoot,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
