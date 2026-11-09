/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject on `buildApp({ db: prisma })` when DATABASE_URL is set,
 * so every store is the Prisma adapter. Fake createAuthUser (new UUID each
 * call). Unique e-mail per run; delete only this file's user rows. skipIf when
 * URL missing.
 *
 * NOT on the rolling-back harness, deliberately. The assertion this file exists
 * for — that exactly ONE `user` row survives a duplicate POST — has to be read
 * AFTER the refusal, and the refusal is a unique violation, which aborts the
 * enclosing Postgres transaction with no savepoint to recover from (design D2,
 * memory: constraint-violation-aborts-test-transaction). Inside a transaction
 * the row count is therefore unreadable. Committing and cleaning up in
 * `afterAll` is what makes the surviving-row half assertable at all, which is
 * why the accounts create-user slice's test stops at the 409 and defers the
 * count here.
 *
 * NO ASSERTION HERE ONLY HELD ON THE FAKE. The five `createMemory*` stores this
 * file used to pass were inert scaffolding: they existed only to satisfy
 * wave 1's `buildApp` signature, and this file's single test never touches
 * conversations, tags, reports, cadastro, prefill or services. Dropping them
 * changes no assertion; `buildApp({ db: prisma })` now builds every store from
 * the client. Since wave 2 the insert runs in the accounts module's
 * create-user slice, under `module_accounts`, on that same client.
 *
 * Oracle: schema-review-hardening auth delta — POST /users with an e-mail
 * that already has a CRM User row is 409 and the user table still has one
 * row for that e-mail.
 *
 * Axes
 *   A1 DATABASE_URL — unset (skip) / set (execute)
 *   A2 POST /users — first vs second same e-mail
 *
 * Outputs: O1 201 + one row; O2 409 + still one row
 *
 * Sampled-cell
 *   first POST            | A2 first  | O1 | 409
 *   second POST same email| A2 second | O2 | 201 / two rows
 *
 * Decision map (POST /users)
 *   Auth duplicate? T 409 (accounts create-user slice test); F continue
 *   CRM P2002? T 409 this file; F 201
 *
 * Out of scope: live Supabase Auth (fake createAuthUser).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_ACCESS_TOKEN } from "@select-lub/core/testing";
import { createFakeGetUser } from "@select-lub/core/testing";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { withConnectRetry } from "@select-lub/core/testing";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("POST /users duplicate e-mail (Postgres)", () => {
  const runId = randomUUID();
  const email = `dup-${runId}@example.com`;
  const createdIds: string[] = [];
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    // Migrating here raced the other live files and duplicated work the whole
    // project now does once, in this Vitest config's `globalSetup`.
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    app = await buildApp({
      db: prisma,
      getUser: createFakeGetUser(),
      createAuthUser: async () => {
        const id = randomUUID();
        createdIds.push(id);
        return { id };
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (!prisma) {
      return;
    }
    if (createdIds.length > 0) {
      await prisma.userUnit.deleteMany({ where: { userId: { in: createdIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.user.deleteMany({ where: { email } });
  });

  it("returns 409 on the second POST and leaves one user row for that e-mail", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, "content-type": "application/json" },
      payload: { email, password: "secret", name: "Um" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, "content-type": "application/json" },
      payload: { email, password: "secret", name: "Dois" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    const rows = await prisma.user.findMany({ where: { email } });
    expect(rows).toHaveLength(1);
  });
});
