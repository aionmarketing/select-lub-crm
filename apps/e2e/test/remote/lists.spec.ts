/**
 * Oracle: deploy — "Published schema matches the published image", which names
 *   these three endpoints: Conversas, Follow-up counts and the Relatórios
 *   conversations summary must answer 2xx rather than a database-schema error
 *   once pending migrations are applied.
 *
 * Reads only: GET with a bearer from the same password grant the SPA uses.
 */
import { expect, test } from "./fixtures.js";

test("the Conversas list answers for the signed-in unit", async ({ crmApi, unitId }) => {
  const response = await crmApi.get("/conversations", { headers: { "x-unit-id": unitId } });
  expect(response.status(), await bodyHint(response)).toBe(200);
});

test("Follow-up counts answer for the signed-in unit", async ({ crmApi, unitId }) => {
  const response = await crmApi.get("/follow-up-counts", { headers: { "x-unit-id": unitId } });
  expect(response.status(), await bodyHint(response)).toBe(200);
});

test("the Relatórios summary answers for the signed-in unit", async ({ crmApi, unitId }) => {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
  const response = await crmApi.get("/reports/conversations", {
    headers: { "x-unit-id": unitId },
    params: {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      granularity: "day",
    },
  });
  expect(response.status(), await bodyHint(response)).toBe(200);
});

/**
 * Includes the response body in a failure message.
 *
 * A schema drift shows up as a 500 whose body names the missing column; that
 * text is the whole diagnostic value of this suite.
 */
async function bodyHint(response: { status: () => number; text: () => Promise<string> }) {
  if (response.status() === 200) return "";
  return `HTTP ${response.status()}: ${(await response.text()).slice(0, 400)}`;
}
