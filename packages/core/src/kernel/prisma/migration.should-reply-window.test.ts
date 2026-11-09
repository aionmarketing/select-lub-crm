/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: should-reply-window task 1.1 / design D1 D2 — nullable should_reply
 * on message; last_prefill_window_closed_at on conversation; existing rows
 * stamped so history does not open a live window.
 *
 * Axes
 *   A1 SQL contains both columns and the existing-row stamp
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   columns + stamp UPDATE | A1 | O1 | missing name or stamp
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
    "../../../prisma/migrations/20260831120000_should_reply_window/migration.sql",
  ),
  "utf8",
);

describe("should_reply + last_prefill_window_closed_at migration", () => {
  it("adds both columns and stamps existing conversations", () => {
    expect(sql).toContain('ALTER TABLE "conversation" ADD COLUMN "last_prefill_window_closed_at" TIMESTAMP(3)');
    expect(sql).toContain('ALTER TABLE "message" ADD COLUMN "should_reply" BOOLEAN');
    expect(sql).toContain(
      'UPDATE "conversation" SET "last_prefill_window_closed_at" = CURRENT_TIMESTAMP WHERE "last_prefill_window_closed_at" IS NULL',
    );
  });
});
