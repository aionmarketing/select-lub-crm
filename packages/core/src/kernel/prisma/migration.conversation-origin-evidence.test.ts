/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: conversation-origin-classification task 1.1 — evidence /
 * campaign / rule-version columns on conversation.
 *
 * Axes
 *   A1 SQL adds the eight nullable columns
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   adds evidence + campaign + rule version | A1 | O1 | missing column
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
    "../../../prisma/migrations/20260831080000_conversation_origin_evidence/migration.sql",
  ),
  "utf8",
);

describe("conversation origin evidence migration", () => {
  it("adds evidence, campaign, and rule-version columns", () => {
    expect(sql).toContain('ADD COLUMN "source_evidence_type"');
    expect(sql).toContain('ADD COLUMN "source_evidence_reference"');
    expect(sql).toContain('ADD COLUMN "source_evidence_at"');
    expect(sql).toContain('ADD COLUMN "ctwa_clid"');
    expect(sql).toContain('ADD COLUMN "campaign_id"');
    expect(sql).toContain('ADD COLUMN "ad_set_id"');
    expect(sql).toContain('ADD COLUMN "ad_id"');
    expect(sql).toContain('ADD COLUMN "classification_rule_version"');
  });
});
