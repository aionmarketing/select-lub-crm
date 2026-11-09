/**
 * Playwright fixtures — Conversas page object plus API seeding (no Evolution).
 *
 * Setup: API + Vite from playwright.config webServer. Auth is MVP auto-login
 * (`VITE_MVP_LOGIN_*` + Supabase). Seed helpers use Prisma in globalSetup and
 * the Playwright `request` context against `E2E_API_BASE` (default
 * `http://127.0.0.1:3000`, the default suite's API) with a bearer from the same
 * auto-login grant — they do not click the UI to build preconditions and do not
 * call Evolution. The tour config sets `E2E_API_BASE` to its own API port so the
 * same fixtures serve both stacks without a second copy.
 *
 * Oracle: harden-suite-branch-coverage repo-foundation E2E scenarios.
 */
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { supabaseAccessToken } from "./supabase-token.js";
import { ConversasPage } from "./pages/conversas-page.js";
import { seedE2eFixtures } from "./seed-e2e.js";
import { seedWithConnectionRetry } from "./seed-retry.js";

const apiBase = process.env.E2E_API_BASE ?? "http://127.0.0.1:3000";

type Fixtures = {
  /** Page object for `/`. */
  conversasPage: ConversasPage;
  /** Direct API client (no Vite proxy) for assertions after auto-login. */
  crmApi: APIRequestContext;
  /** Auto: reset SQL fixtures so retries and spec order cannot leak schedules. */
  e2eSeed: void;
};

/**
 * Re-exported from its own module so existing specs keep importing it here.
 * @see ./supabase-token.ts
 */
export { supabaseAccessToken } from "./supabase-token.js";

/**
 * Playwright `test` extended with the Conversas page object and an authed API client.
 */
export const test = base.extend<Fixtures>({
  e2eSeed: [
    async ({ browserName }, use) => {
      void browserName;
      // Retried, not merely called: at start of run the loopback forwarder
      // drops connections while the dev servers boot, and the seed died that
      // way 14 times across 9 runs — every one of them in test #2 or #4 of 30,
      // never in tests 5..30. Only a connectivity failure is retried, and only
      // a few times; see `seed-retry.ts` for what was measured and why this is
      // waiting on a signal rather than papering over one.
      await seedWithConnectionRetry(seedE2eFixtures, {
        attempts: 4,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      await use();
    },
    { auto: true },
  ],
  conversasPage: async ({ page }, use) => {
    await use(new ConversasPage(page));
  },
  crmApi: async ({ playwright }, use) => {
    const token = await supabaseAccessToken();
    const context = await playwright.request.newContext({
      baseURL: apiBase,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    await use(context);
    await context.dispose();
  },
});

/** Re-exported Playwright assertion helper for expect matchers in e2e specs. */
export { expect };
