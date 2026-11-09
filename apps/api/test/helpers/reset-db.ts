/**
 * Truncates selected CRM tables between Vitest cases that persist to the test database.
 */
import { prisma, shouldRunLiveTests } from "@select-lub/core/db";
import { assertLiveDbReady } from "./assert-live-db-ready.js";

const tables = [
  "outbox_message",
  "message",
  "conversation",
  "webhook_event",
  "whatsapp_connection",
  "unit",
] as const;

/**
 * Clears fixture tables when the environment is equipped for live tests; no-op
 * when `DATABASE_URL` (env.ts copies `DATABASE_URL_TEST` onto it) is unset.
 *
 * Gated on `shouldRunLiveTests()` rather than truthiness of
 * `DATABASE_URL_TEST`: a bare truthiness check would TRUNCATE whatever host
 * `DATABASE_URL_TEST` happens to name, including a remote one, with no
 * refusal — the same defect openspec/specs/repo-foundation's "Database-writing
 * tests require a local target" requirement removes from the `*.live.test.ts`
 * suites. A non-loopback `DATABASE_URL` now throws instead of truncating it
 * (see shouldRunLiveTests), unless `LIVE_TESTS_ALLOW_REMOTE=1`.
 *
 * @returns Resolves when listed tables are truncated with `RESTART IDENTITY CASCADE`, or immediately when the environment is not equipped for live tests.
 */
export async function resetTestDatabase() {
  if (!shouldRunLiveTests()) {
    return;
  }
  assertLiveDbReady(prisma, "resetTestDatabase");
  const list = tables.map((name) => `"${name}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
