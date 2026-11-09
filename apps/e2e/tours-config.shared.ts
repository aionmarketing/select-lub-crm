/**
 * Shared definition behind every exploratory-tour Playwright config.
 *
 * ONE place for the provider guard, the no-reuse server discipline and the
 * stack's shape; each config supplies only its ports, its instance name and
 * which files it collects.
 *
 * **This module exists because of a specific failure.** Until 2026-09-14 the
 * tours config blanked `PLACAS_TOKEN`, a name nothing in this repo reads, while
 * `resolvePlacasAccess` reads `APIBRASIL_BEARER_TOKEN` and resolves credentials
 * BEFORE the mock opt-in — so the cadastro tour drove the real, credit-metered
 * APIBrasil while the config claimed otherwise, and it billed. A credential list
 * that lives in one file and is checked by nobody is how that survived. A SECOND
 * copy of that list, made by copy-paste for a second config, is two places for
 * it to drift and one of them will be the one somebody fixes. So the list below
 * is imported, never duplicated.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { toursDatabaseUrl } from "./e2e-database.js";
import { tourAuthEnv } from "./tour-auth-env.js";
import { tourProviderEnv } from "./tour-provider-env.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Where every tour signs in: the LOCAL Supabase Auth, as the committed test
 * user (OpenSpec tours-local-supabase). Assigned onto `process.env` AFTER the
 * `.env` load, unconditionally, so the `.env`'s production URL, keys and login
 * lose here as well as in the runner — and this process (the test runner, whose
 * `crmApi` fixture makes its own password grant), the API and Vite all read the
 * same local values. `run-tours.mjs` supplies `TOUR_SUPABASE_ANON_KEY` and
 * `TOUR_SUPABASE_SERVICE_ROLE_KEY` from the running stack; without it `tourAuthEnv` throws, naming the start command,
 * rather than letting a bare `playwright test --config` fall back to the `.env`.
 */
const tourAuth = tourAuthEnv({
  anonKey: env.TOUR_SUPABASE_ANON_KEY ?? "",
  serviceRoleKey: env.TOUR_SUPABASE_SERVICE_ROLE_KEY ?? "",
});
Object.assign(process.env, tourAuth);

/**
 * The provider guard — blanked credentials, the Motul/Tecfil loopback redirects
 * and the mock opt-ins — lives in `tour-provider-env.ts`, a module with no
 * import-time side effects, so `test/tour-provider-guard.test.ts` can prove what
 * the API receives without loading `.env`. Re-exported here so existing readers
 * keep one import site.
 *
 * Motul and Tecfil were the hole blanking could not close: neither takes a
 * credential and both hosts are compiled into their clients. The
 * `MOTUL_BASE_URL` / `TECFIL_BASE_URL` seam is on main and read per call, and
 * the tour API now sets both to a loopback (close-stated-coverage-gaps 1.2).
 */
export { blankedProviderCredentials, tourProviderEnv, tourProviderRedirects } from "./tour-provider-env.js";

/** Ports and collection rules that distinguish one tour config from another. */
export type TourStackOptions = {
  /** API port. Must differ per config: `reuseExistingServer` is false everywhere. */
  apiPort: number;
  /** Vite port. */
  webPort: number;
  /** Mock Evolution port. */
  evolutionPort: number;
  /** Files this config collects, relative to `test/tours`. */
  testMatch: string | string[];
  /** Files this config must NOT collect. */
  testIgnore?: string | string[];
  /** Extra API env, e.g. a different `EVOLUTION_INSTANCE_NAME`. */
  apiEnv?: Record<string, string>;
  /** Output directory, kept distinct so two configs never overwrite each other. */
  outputDir: string;
};

/**
 * Builds a tour config: own ports, own servers, the shared provider guard.
 *
 * Every server sets `reuseExistingServer: false` so a tour can never attach to a
 * dev API whose `SERVER_URL` points at the hosted Evolution — and so a stale
 * listener fails the run loudly instead of serving it quietly.
 *
 * @param options - Ports, collection rules and any extra API env.
 * @returns A Playwright config for that stack.
 */
export function defineTourConfig(options: TourStackOptions) {
  const mockEvolutionUrl = `http://127.0.0.1:${options.evolutionPort}`;
  const apiBase = `http://127.0.0.1:${options.apiPort}`;
  const webBase = `http://127.0.0.1:${options.webPort}`;

  // Read by `test/fixtures.ts` in THIS process (the test runner), not by a
  // server: `webServer.env` would only reach the spawned API. Without it the
  // `crmApi` fixture would assert against the default suite's API while the
  // browser drove this stack.
  process.env.E2E_API_BASE = apiBase;

  // Same reason, same mechanism: the tour stack gets its dedicated database,
  // not the worktree's dev one nor the e2e suite's. Set here so `...env` carries it to the API and
  // worker this config spawns; `run-tours.mjs` provisions it before Playwright
  // starts, because Playwright boots `webServer` before `globalSetup` runs.
  process.env.DATABASE_URL = toursDatabaseUrl(repoRoot);

  return defineConfig({
    testDir: "./test/tours",
    testMatch: options.testMatch,
    ...(options.testIgnore ? { testIgnore: options.testIgnore } : {}),
    globalSetup: "./test/global-setup.ts",
    fullyParallel: false,
    forbidOnly: Boolean(env.CI),
    // A tour is exploratory: a retry would hide the flake that is itself a finding.
    retries: 0,
    workers: 1,
    reporter: "list",
    timeout: 120_000,
    outputDir: options.outputDir,
    use: {
      baseURL: webBase,
      // Always on: the trace and screenshots are the evidence attached to the
      // run report, not just a failure aid.
      trace: "on",
      screenshot: "on",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: [
      {
        command: "node apps/e2e/mock-evolution.mjs",
        cwd: repoRoot,
        url: `${mockEvolutionUrl}/health`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: { ...env, E2E_EVOLUTION_PORT: String(options.evolutionPort) },
      },
      {
        command: "pnpm --filter @select-lub/api dev",
        cwd: repoRoot,
        url: `${apiBase}/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          ...env,
          ...tourProviderEnv(),
          ...tourAuth,
          SERVER_URL: mockEvolutionUrl,
          EVOLUTION_WEBHOOK_URL: "",
          HOST: "127.0.0.1",
          PORT: String(options.apiPort),
          ...options.apiEnv,
        },
      },
      {
        command: `pnpm --filter @select-lub/web dev --port ${options.webPort} --strictPort`,
        cwd: repoRoot,
        url: webBase,
        reuseExistingServer: false,
        timeout: 120_000,
        env: { ...env, ...tourAuth, API_PROXY_TARGET: apiBase, E2E_API_BASE: apiBase },
      },
    ],
  });
}
