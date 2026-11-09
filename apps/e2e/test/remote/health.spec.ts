/**
 * Oracle: deploy — "Published images report their build identity" (the API
 *   health path names the commit and the variant; the worker's names the
 *   commit) and "Remote smoke fails on a stale origin". Read-only.
 *
 * This is the check the whole change exists for: before it, the only evidence
 * of which version an origin served was the date on its Fly release.
 */
import { expect, expectedCommit, expectedVariant, test, workerURL } from "./fixtures.js";

test("the API reports the commit and variant this origin was published with", async ({ request }) => {
  // Relative, so Playwright resolves it against baseURL and a trailing slash on
  // E2E_BASE_URL cannot turn this into `//health` (a 404 on Fastify).
  const response = await request.get("/health");
  expect(response.status()).toBe(200);

  const body = (await response.json()) as { status: string; commit: string; uiVariant: string };
  expect(body.status).toBe("ok");
  expect(
    body.commit,
    `published origin reports commit ${body.commit}; expected ${expectedCommit}`,
  ).toBe(expectedCommit);
  expect(body.uiVariant).toBe(expectedVariant);
});

test("the worker was published from the same commit as the API", async ({ request }) => {
  const response = await request.get(new URL("/health", workerURL).href);
  expect(response.status()).toBe(200);

  const body = (await response.json()) as { status: string; commit: string };
  expect(body.status).toBe("ok");
  // Same release, same commit: deploy — "Both origins show the same data and
  // version" is about the two SPAs, but a worker left behind is the same class
  // of drift, and it is what made the stale ingest fix invisible for a week.
  expect(
    body.commit,
    `published worker reports commit ${body.commit}; expected ${expectedCommit}`,
  ).toBe(expectedCommit);
});
