/**
 * Test design (testing-strategy)
 *
 * Setup: no-DB tier reads migration.sql / fixture-dedupe.sql from disk.
 * Live tier (skipIf !DATABASE_URL): pg Client, scratch schema srh_test_<runId>,
 * replay every migration directory older than 20260831040000_schema_review_hardening,
 * run fixture-dedupe.sql, run the target migration.sql as one BEGIN…COMMIT.
 *
 * Oracle: schema-review-hardening task 1.3 / design D3 — contact-row keep
 * primary-else-oldest, primary flattening newest updated_at, close extra open
 * tag rows, round odometer_km; re-running the D3 DML is a no-op.
 *
 * Axes
 *   A1 SQL contains vs missing D3 / guards / USING round / five partial uniques
 *   A2 DATABASE_URL — unset (skip live) / set (execute)
 *   A3 pre-migration — duplicate normalized, double primary, two open tags, 49999.6
 *   A4 post-migration — D3 keep-rules; odometer 50000; second DML pass unchanged
 *
 * Outputs: O1 substring match; O2 skip; O3 fixture rows; O4 survivors
 *
 * Sampled-cell
 *   D3/guards/round/partials in SQL | A1 | O1 | missing token
 *   fixture documents shapes        | A1 | O1 | missing ph-keep / 49999.6
 *   execute keep-rules + re-run DML | A2 set A3 A4 | O4 | extra row / wrong km
 *
 * Decision map (migration.sql as SUT)
 *   D1 same normalized + a primary     T: keep primary id
 *   D2 same normalized, no primary     T: keep oldest created_at
 *   D3 two is_primary, different nums  T: newest updated_at stays primary
 *   D4 two open conversation_tag       T: oldest open; extra removed_at set
 *   D5 service.odometer_km 49999.6     T: 50000 after round
 *
 * Out of scope: running the full migration.sql twice (DROP INDEX / ADD COLUMN
 * are not idempotent); mutating public tables (already post-migration).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const TARGET_MIGRATION = "20260831040000_schema_review_hardening";
const srcDir = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(srcDir, "../../../prisma/migrations");
const dir = join(migrationsRoot, TARGET_MIGRATION);
const sql = readFileSync(join(dir, "migration.sql"), "utf8");
const fixture = readFileSync(join(dir, "fixture-dedupe.sql"), "utf8");

const live = Boolean(process.env.DATABASE_URL);
const dml = sql.slice(0, sql.indexOf("-- DropIndex"));

function priorMigrationDirs(): string[] {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function execSql(client: Client, body: string) {
  await client.query(`BEGIN;\n${body}\nCOMMIT;`);
}

describe("schema review hardening migration", () => {
  it("dedupes, guards, rounds odometer, and adds the five partial uniques", () => {
    expect(sql).toContain('DELETE FROM "customer_phone" AS loser');
    expect(sql).toContain('ORDER BY cand."is_primary" DESC, cand."created_at" ASC, cand."id" ASC');
    expect(sql).toContain('ORDER BY cand."updated_at" DESC, cand."id" DESC');
    expect(sql).toContain('SET "removed_at" = NOW()');
    expect(sql).toContain("RAISE EXCEPTION 'customer_reconciliation_pending");
    expect(sql).toContain('RAISE EXCEPTION \'"user" has % duplicate email');
    expect(sql).toContain('USING round("odometer_km")::integer');
    expect(sql).toContain('CREATE UNIQUE INDEX "customer_reconciliation_pending_open_field_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "vehicle_reconciliation_pending_open_field_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "conversation_tag_open_apply_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "customer_phone_primary_per_customer_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "customer_email_primary_per_customer_key"');
  });

  it("documents the duplicate shapes the pre-hardening schema would accept", () => {
    expect(fixture).toContain("ph-keep");
    expect(fixture).toContain("ph-lose");
    expect(fixture).toContain("ph-stale");
    expect(fixture).toContain("ph-fresh");
    expect(fixture).toContain("ct-old");
    expect(fixture).toContain("ct-extra");
    expect(fixture).toContain("49999.6");
    expect(fixture).toContain('DROP INDEX "conversation_tag_open_apply_key"');
  });
});

describe.skipIf(!live)("schema review hardening migration (executed)", () => {
  let client: Client | null = null;
  let schemaName = "";

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("expected DATABASE_URL when live describe runs");
    }

    client = new Client({ connectionString });
    await client.connect();
    schemaName = `srh_test_${randomUUID().replace(/-/g, "")}`;
    await client.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${escapeIdentifier(schemaName)}`);

    for (const name of priorMigrationDirs()) {
      const body = readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8");
      await execSql(client, body);
    }
  }, 120_000);

  afterAll(async () => {
    if (!client) {
      return;
    }
    try {
      await client.query("ROLLBACK");
    } catch {
      // no open transaction
    }
    try {
      if (schemaName) {
        await client.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schemaName)} CASCADE`);
      }
    } finally {
      await client.end();
    }
  }, 30_000);

  it("keeps D3 survivors, rounds odometer, and leaves a second DML pass unchanged", async () => {
    const pg = client;
    if (!pg) {
      throw new Error("expected pg client after beforeAll");
    }

    await execSql(pg, fixture);

    const beforePhones = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "customer_phone"`,
    );
    expect(beforePhones.rows[0]?.n).toBe("6");

    await execSql(pg, sql);

    const phonesA = await pg.query<{ id: string }>(
      `SELECT id FROM "customer_phone" WHERE customer_id = 'srh-cust-a' ORDER BY id`,
    );
    expect(phonesA.rows.map((row) => row.id)).toEqual(["ph-keep"]);

    const phonesB = await pg.query<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM "customer_phone" WHERE customer_id = 'srh-cust-b' ORDER BY id`,
    );
    expect(phonesB.rows).toEqual([
      { id: "ph-fresh", is_primary: true },
      { id: "ph-stale", is_primary: false },
    ]);

    const phonesC = await pg.query<{ id: string }>(
      `SELECT id FROM "customer_phone" WHERE customer_id = 'srh-cust-c' ORDER BY id`,
    );
    expect(phonesC.rows.map((row) => row.id)).toEqual(["ph-old"]);

    const emails = await pg.query<{ id: string }>(
      `SELECT id FROM "customer_email" WHERE customer_id = 'srh-cust-a' ORDER BY id`,
    );
    expect(emails.rows.map((row) => row.id)).toEqual(["em-keep"]);

    const tags = await pg.query<{ id: string; closed: boolean }>(
      `SELECT id, (removed_at IS NOT NULL) AS closed FROM "conversation_tag" ORDER BY id`,
    );
    expect(tags.rows).toEqual([
      { id: "ct-extra", closed: true },
      { id: "ct-old", closed: false },
    ]);

    const odometer = await pg.query<{ odometer_km: number }>(
      `SELECT odometer_km FROM "service" WHERE id = 'srh-svc'`,
    );
    expect(odometer.rows[0]?.odometer_km).toBe(50000);

    await execSql(pg, dml);

    const phonesAfterRerun = await pg.query<{ id: string }>(
      `SELECT id FROM "customer_phone" ORDER BY id`,
    );
    expect(phonesAfterRerun.rows.map((row) => row.id)).toEqual(["ph-fresh", "ph-keep", "ph-old", "ph-stale"]);
    const odometerAgain = await pg.query<{ odometer_km: number }>(
      `SELECT odometer_km FROM "service" WHERE id = 'srh-svc'`,
    );
    expect(odometerAgain.rows[0]?.odometer_km).toBe(50000);
  }, 120_000);
});
