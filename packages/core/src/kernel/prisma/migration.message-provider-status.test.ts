/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: message-status-updates task 1.2 — Message provider status
 * columns plus content_unavailable default false.
 *
 * Axes
 *   A1 SQL adds the six columns
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   adds status, four timestamps, unavailable | A1 | O1 | missing column
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
    "../../../prisma/migrations/20260831070000_message_provider_status/migration.sql",
  ),
  "utf8",
);

describe("message provider_status migration", () => {
  it("adds status, timestamps, and content_unavailable", () => {
    expect(sql).toContain('ADD COLUMN "provider_status"');
    expect(sql).toContain('ADD COLUMN "sent_at"');
    expect(sql).toContain('ADD COLUMN "delivered_at"');
    expect(sql).toContain('ADD COLUMN "read_at"');
    expect(sql).toContain('ADD COLUMN "failed_at"');
    expect(sql).toContain('ADD COLUMN "content_unavailable" BOOLEAN NOT NULL DEFAULT false');
  });
});
