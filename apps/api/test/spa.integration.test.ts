/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject via `buildApp({ db: tx, spaRoot })` inside one
 *   rolling-back transaction per test (`withTestTransaction`) on the worktree
 *   database, with spaRoot = a temp dir
 * that holds index.html (no Vite build). Auth hook skips non-API GETs.
 *
 * Spec rule (deploy): unknown GET returns the SPA shell; GET /health
 * still returns the health payload; existing API routes keep priority.
 *
 * Axes
 *   A1 path — /health /api/health /no-such-page /conversations
 *   A2 method — GET / POST
 *
 * Outputs
 *   O1 health JSON 200; O2 SPA html 200; O3 401 on API; O4 404 JSON
 *
 * Sampled-cell
 *   GET /health                 | A1 health | O1 | SPA html
 *   GET /api/health              | A1 rewrite | O1 | SPA html
 *   GET /no-such-page            | A1 spa | O2 | health JSON
 *   GET /conversations no token  | A1 api | O3 | SPA html
 *   POST /no-such-page           | A2 POST | O3 | SPA html (auth runs first)

 *
 * Decision map (registerSpa + auth skip + rewriteUrl)
 *   D1 rewrite /api prefix T: /api/health it; F: /health and /no-such-page
 *   D2 health route T: both health its; F: spa / conversations / POST
 *   D3 unauthenticated GET not API T: spa it; F: conversations 401
 *   D4 notFound GET not API T: spa it; F: POST 404
 *
 * Out of scope: Vite-built hashed assets; Fly HTTPS.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { describeWithDatabase, withTestTransaction } from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";

const SPA_MARK = "spa-shell-fixture";

const db = () => prisma as PrismaClient;

/**
 * The exact value `/health` answers with now that `buildApp` requires a client.
 *
 * ASSERTION THAT ONLY HELD ON THE FAKE: both health cases below asserted
 * `database: expect.stringMatching(/^(connected|skipped)$/)` — a pattern that
 * accepts either arm and so could not fail whichever arm the app took. It was
 * written that way because `buildMemoryApp` produced "skipped" while a developer
 * with `DATABASE_URL` set produced "connected", and the file had no way to know
 * which it would get. With `db` required, "connected" is the only answer a caller
 * can receive, so the value is pinned exactly. No positive control is added for
 * "skipped": that arm survives only behind the wave-1-only `stores`-only option
 * and wave 4 deletes it, so the alternative is unreachable rather than unsampled.
 */
const HEALTH_DATABASE = "connected";

function spaRoot() {
  const dir = mkdtempSync(join(tmpdir(), "select-lub-spa-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><body>${SPA_MARK}</body></html>`);
  return dir;
}

describeWithDatabase("SPA static fallback", () => {
  const apps: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns 200 health JSON for GET /health while the SPA is registered", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const app = await buildApp({ db: tx, spaRoot: spaRoot() });
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "ok",
          database: HEALTH_DATABASE,
        }),
      );
      expect(response.body).not.toContain(SPA_MARK);
    }));

  it("returns 200 health JSON for GET /api/health after the /api rewrite", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const app = await buildApp({ db: tx, spaRoot: spaRoot() });
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "ok",
          database: HEALTH_DATABASE,
        }),
      );
    }));

  it("returns the SPA shell for an unknown GET path", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const app = await buildApp({ db: tx, spaRoot: spaRoot() });
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/no-such-page" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.body).toContain(SPA_MARK);
    }));

  it("still returns 401 for GET /conversations without a token", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const app = await buildApp({ db: tx, spaRoot: spaRoot() });
      apps.push(app);

      const response = await app.inject({ method: "GET", url: "/conversations" });

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(SPA_MARK);
    }));

  it("does not return the SPA shell for POST to an unknown path", () =>
    withTestTransaction(db(), async (tx: DbClient) => {
      const app = await buildApp({ db: tx, spaRoot: spaRoot() });
      apps.push(app);

      const response = await app.inject({ method: "POST", url: "/no-such-page" });

      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(SPA_MARK);
    }));
});
