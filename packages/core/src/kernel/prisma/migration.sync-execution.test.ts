/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: omie-http-adapter task 2.1 — Prisma SyncExecution + IntegrationError.
 *
 * Axes
 *   A1 SQL contains sync_execution / integration_error tables and indexes
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   creates both tables + status / integration indexes | A1 | O1 | missing name
 *
 * Out of scope: live migrate (db:generate / operator migrate); field-sync columns.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260831050000_sync_execution_integration_error/migration.sql",
  ),
  "utf8",
);

describe("sync_execution + integration_error migration", () => {
  it("creates both tables and their indexes", () => {
    expect(sql).toContain('CREATE TABLE "sync_execution"');
    expect(sql).toContain('CREATE TABLE "integration_error"');
    expect(sql).toContain('"retryable" BOOLEAN NOT NULL');
    expect(sql).toContain('"attempt_count"');
    expect(sql).toContain("sync_execution_status_idx");
    expect(sql).toContain("integration_error_integration_created_at_idx");
  });
});
