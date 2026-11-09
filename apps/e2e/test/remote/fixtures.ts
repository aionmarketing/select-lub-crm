/**
 * Fixtures for the read-only smoke against a published origin.
 *
 * MUST NOT import `../fixtures.js`, `../seed-e2e.js` or `@select-lub/core/db`:
 * those reach Prisma, and this suite runs against the database real people see
 * (deploy — "Remote smoke writes nothing"). `../remote-is-read-only.test.ts`
 * enforces that by reading these files.
 */
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { supabaseAccessToken } from "../supabase-token.js";

/** Origin under test, e.g. `https://select-lub-crm-api.example.invalid`. */
export const baseURL = process.env.E2E_BASE_URL ?? "";

/** Commit the published image is expected to report; `run-remote.mjs` defaults it to HEAD. */
export const expectedCommit = process.env.E2E_EXPECT_COMMIT ?? "";

/** UI variant this origin is expected to serve. */
export const expectedVariant = process.env.E2E_EXPECT_VARIANT === "antigravity" ? "antigravity" : "cursor";

/** Published worker origin whose health is checked alongside the API's. */
export const workerURL = process.env.E2E_WORKER_URL ?? "https://select-lub-crm-worker.example.invalid";

type Fixtures = {
  /** Bearer-authenticated client for the origin under test. */
  crmApi: APIRequestContext;
  /** `x-unit-id` value: the first unit the signed-in user belongs to. */
  unitId: string;
};

export const test = base.extend<Fixtures>({
  crmApi: async ({ playwright }, use) => {
    const token = await supabaseAccessToken();
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    await use(context);
    await context.dispose();
  },
  unitId: async ({ crmApi }, use) => {
    const response = await crmApi.get("/auth/me");
    expect(response.status(), "GET /auth/me on the published origin").toBe(200);
    const me = (await response.json()) as { unitIds?: string[]; currentUnitId?: string };
    const unitId = me.currentUnitId ?? me.unitIds?.[0];
    expect(unitId, "the signed-in user belongs to at least one unit").toBeTruthy();
    await use(unitId as string);
  },
});

export { expect };
