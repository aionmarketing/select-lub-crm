/**
 * Read-only smoke against a PUBLISHED origin (`E2E_BASE_URL`).
 *
 * Deliberately not the default config with a different baseURL: those specs
 * seed fixture rows through Prisma and create customers, schedules and outbox
 * rows. Pointed at a published origin they would write test data into the demo
 * everyone with the link sees — the exact thing `test/seed-target.ts`'s
 * loopback guard exists to prevent. So: no `webServer` (nothing is started),
 * no `globalSetup` (nothing is seeded), and `test/remote` may not import the
 * seed or `@select-lub/core/db` at all. `test/remote-is-read-only.test.ts` keeps
 * that true.
 *
 * Invoke via `pnpm test:e2e:remote`, which sets nothing but forwards the
 * environment; see `run-remote.mjs`.
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

const baseURL = env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error(
    "E2E_BASE_URL is required, e.g. E2E_BASE_URL=https://select-lub-crm-api.example.invalid pnpm test:e2e:remote",
  );
}

export default defineConfig({
  testDir: "./test/remote",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
