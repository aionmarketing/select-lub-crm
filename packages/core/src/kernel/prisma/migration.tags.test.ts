/**
 * Test design (testing-strategy)
 *
 * Setup: read the tags/templates migration SQL from disk. No Prisma generate.
 *
 * Oracle: tags-and-templates-crud task 2.1 — partial unique indexes for
 * active (unitId, name) and open apply (conversationId, tagId).
 *
 * Axes: SQL contains vs missing the three unique index names.
 * Out of scope: live migrate deploy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260828120000_tags_templates/migration.sql"),
  "utf8",
);

describe("tags templates migration", () => {
  it("contains unique active name and open-apply indexes", () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "tag_unit_id_name_active_key"');
    expect(sql).toContain('WHERE "active" = true');
    expect(sql).toContain('CREATE UNIQUE INDEX "template_unit_id_name_active_key"');
    expect(sql).toContain(`WHERE "status" = 'active'`);
    expect(sql).toContain('CREATE UNIQUE INDEX "conversation_tag_open_apply_key"');
    expect(sql).toContain('WHERE "removed_at" IS NULL');
  });
});
