/**
 * Test design (testing-strategy)
 *
 * Setup: read the user/user_unit migration SQL from disk. No Prisma generate.
 *
 * Oracle: auth-unit-matrix task 2.1 — User (UUID PK) and UserUnit unique
 * (userId, unitId). No PostgREST Data API / RLS in this SQL.
 *
 * Axes: SQL contains vs missing CREATE TABLE user / user_unit and the
 * composite primary key on (user_id, unit_id).
 *
 * Out of scope: live migrate deploy; Auth admin createUser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260828140000_user_unit/migration.sql"),
  "utf8",
);

describe("user unit migration", () => {
  it("creates user and user_unit tables with unique membership pair", () => {
    expect(sql).toContain('CREATE TABLE "user"');
    expect(sql).toContain('CREATE TABLE "user_unit"');
    expect(sql).toContain('CONSTRAINT "user_pkey" PRIMARY KEY ("id")');
    expect(sql).toContain('CONSTRAINT "user_unit_pkey" PRIMARY KEY ("user_id","unit_id")');
    expect(sql).not.toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).not.toContain("GRANT ALL ON TABLE");
  });
});
