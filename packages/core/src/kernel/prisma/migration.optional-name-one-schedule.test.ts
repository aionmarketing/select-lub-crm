/**
 * Test design (testing-strategy)
 *
 * Setup: reads migration.sql from disk. No Postgres.
 *
 * Oracle: optional-name-one-schedule-mvp design D1/D3 — Customer.name
 *   nullable; partial unique on scheduled_message.service_id where not
 *   CANCELLED.
 *
 * Axes
 *   A1 SQL contains vs missing DROP NOT NULL / unique index / CANCELLED predicate
 *
 * Outputs: O1 substring match
 *
 * Sampled-cell
 *   name DROP NOT NULL                         | A1 | O1 | still NOT NULL
 *   unique index + status <> CANCELLED         | A1 | O1 | unique on all statuses
 *
 * Decision map (migration.sql as SUT)
 *   D1 ALTER name DROP NOT NULL                T this file
 *   D2 partial unique WHERE service_id IS NOT NULL AND status <> CANCELLED
 *
 * Out of scope: live migrate (CI Postgres); rewriting historical "Omie" rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TARGET_MIGRATION = "20260831200000_optional_name_one_schedule";
const srcDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(srcDir, "../../../prisma/migrations", TARGET_MIGRATION, "migration.sql"),
  "utf8",
);

describe("optional name and one-schedule migration", () => {
  it("makes customer.name nullable and unique among non-cancelled schedules per service", () => {
    expect(sql).toContain('ALTER TABLE "customer" ALTER COLUMN "name" DROP NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX "scheduled_message_one_non_cancelled_service"');
    expect(sql).toContain('"service_id" IS NOT NULL AND "status" <> \'CANCELLED\'');
  });
});
