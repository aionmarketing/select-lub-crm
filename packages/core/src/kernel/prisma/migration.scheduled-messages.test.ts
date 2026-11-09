/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: scheduled-messages task 1.2 — IntervalRule, ScheduledMessage
 *   with non-null created_by_user_id FK, outbox idempotency_key unique.
 *
 * Axes
 *   A1 SQL creates both tables and the outbox column
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   tables + unique keys + user FK | A1 | O1 | missing name
 *
 * Out of scope: live migrate (db:generate / operator migrate).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260831090000_scheduled_messages/migration.sql",
  ),
  "utf8",
);

describe("scheduled messages migration", () => {
  it("creates interval_rule, scheduled_message, and unique outbox idempotency_key", () => {
    expect(sql).toContain('CREATE TABLE "interval_rule"');
    expect(sql).toContain('CREATE TABLE "scheduled_message"');
    expect(sql).toContain('"created_by_user_id" UUID NOT NULL');
    expect(sql).toContain("scheduled_message_created_by_user_id_fkey");
    expect(sql).toContain('ADD COLUMN "idempotency_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "outbox_message_idempotency_key_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "scheduled_message_idempotency_key_key"');
  });
});
