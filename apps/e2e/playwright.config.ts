import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { databaseIsProvidedByCi, e2eDatabaseUrl } from "./e2e-database.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// AFTER the .env load, deliberately. Point this process — and, through `...env`
// below, every server it spawns — at the dedicated e2e database rather than the
// worktree's dev one. Assigning before the load would also work, because
// `loadEnvFile` does not override an already-set variable, but that is a
// subtlety to depend on; assigning after wins unconditionally.
//
// Naming only; creating, migrating and seeding happen in the `test` script,
// before Playwright starts. Doing the heavy work here would make even
// `playwright test --list` provision a database.
//
// Skipped under CI, which already passes a dedicated `selectlub_e2e` in the
// job environment — overriding it there would point the suite at a database
// named after the runner's checkout directory, which nothing created.
if (!databaseIsProvidedByCi(process.env)) {
  process.env.DATABASE_URL = e2eDatabaseUrl(repoRoot);
}

const mockEvolutionUrl = "http://127.0.0.1:18080";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  // Three quarantined suites, three different reasons, one line.
  // `live/**` may send a real WhatsApp through hosted Evolution — expensive and
  // irreversible. `remote/**` talks to a PUBLISHED origin. `tours/**` holds
  // exploratory tours transcribed from a live drive, fragile by design and never
  // a merge gate. None belongs in `pnpm test:e2e` or in pull-request CI, and
  // `test/ci-excludes-live.test.ts` pins the exclusions.
  testIgnore: ["**/live/**", "**/remote/**", "**/tours/**"],
  globalSetup: "./test/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(env.CI),
  retries: env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
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
      command: "node apps/e2e/mock-evolution.mjs",
      cwd: repoRoot,
      url: `${mockEvolutionUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @select-lub/api dev",
      cwd: repoRoot,
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...env,
        SERVER_URL: mockEvolutionUrl,
        EVOLUTION_WEBHOOK_URL: "",
        HOST: "127.0.0.1",
        PORT: "3000",
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
