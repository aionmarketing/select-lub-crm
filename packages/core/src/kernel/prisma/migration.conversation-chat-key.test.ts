/**
 * Test design (testing-strategy)
 *
 * Setup: no-DB tier reads migration.sql / fixture-merge.sql / ingest
 * migration from disk. Live tier (skipIf !DATABASE_URL): pg Client, scratch
 * schema merge_test_<runId>, replay every migration directory older than
 * 20260830200000_conversation_chat_key, run fixture-merge.sql, run the
 * target migration.sql as one BEGIN…COMMIT simple query.
 *
 * Oracle: conversation-phone-unique tasks 2.1–2.2 — rename to chat_key,
 * merge duplicate 1:1 threads, unique (connection, chat_key) and
 * (conversation_id, external_message_id), drop message.whatsapp_connection_id,
 * CHECK digits or %@g.us. Old ingest unique was (connection, remote_jid).
 * Faithful seed (2026-08-30): distinct external_message_id per split row.
 *
 * Axes
 *   A1 SQL contains vs missing rename / CHECK / new uniques / merge tag dedupe
 *   A2 DATABASE_URL — unset (skip live) / set (execute merge)
 *   A3 pre-migration — split pair legal; JID string as customer_phone_normalized legal
 *   A4 post-migration — one conversation; both messages on survivor; one tag;
 *      remote_jid = latest last_message_at; CHECK rejects JID as chat_key
 *
 * Outputs: O1 substring match; O2 skip; O3 two conversations + probe insert;
 *   O4 one survivor row + CHECK 23514
 *
 * Sampled-cell
 *   rename/CHECK/uniques in SQL     | A1 | O1 | missing token
 *   merge/tag-dedupe tokens in SQL  | A1 | O1 | missing DELETE conversation
 *   old unique, fixture documents   | A1 | O1 | missing @c.us / two inbox rows
 *   execute split-pair merge        | A2 set A3 A4 | O3 then O4 | two rows after / CHECK ok
 *
 * Decision map (migration.sql as SUT)
 *   D1 merge map id <> survivor     T: abs absorbed; F: surv kept
 *   D2 message DELETE EXISTS        F: distinct ids (this fixture); T: infeasible
 *      under message_whatsapp_connection_id_external_message_id_key
 *   D3 tag DELETE EXISTS            T: shared tag-1 on both rows
 *   D4 survivor remote_jid          latest last_message_at → @c.us (after absorbee DELETE)
 *   D5 CHECK conversation_chat_key_format  T: JID insert rejected
 *   D6 DELETE conversation before UPDATE remote_jid  (old unique still live)
 *
 * Out of scope: cadastro_prefill merge (fixture has no prefill rows);
 *   tag DELETE EXISTS false (absorbee-only tag; task 2.2 is shared tag);
 *   dropping the old message unique to force D2 true (rejected 2026-08-30);
 *   running the merge on public tables (already post-migration).
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

const TARGET_MIGRATION = "20260830200000_conversation_chat_key";
const srcDir = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(srcDir, "../../../prisma/migrations");
const dir = join(migrationsRoot, TARGET_MIGRATION);
const sql = readFileSync(join(dir, "migration.sql"), "utf8");
const fixture = readFileSync(join(dir, "fixture-merge.sql"), "utf8");
const oldIngest = readFileSync(join(migrationsRoot, "20260826011707_ingest_pipeline/migration.sql"), "utf8");

const live = Boolean(process.env.DATABASE_URL);

function priorMigrationDirs(): string[] {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name < TARGET_MIGRATION)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function execSql(client: Client, body: string) {
  await client.query(`BEGIN;\n${body}\nCOMMIT;`);
}

function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return undefined;
  }
  const { constraint } = error;
  return typeof constraint === "string" ? constraint : undefined;
}

describe("conversation chat_key migration", () => {
  it("renames the phone column and adds the format CHECK and new uniques", () => {
    expect(sql).toContain('RENAME COLUMN "customer_phone_normalized" TO "chat_key"');
    expect(sql).toContain('CHECK ("chat_key" ~ \'^[0-9]+$\' OR "chat_key" LIKE \'%@g.us\')');
    expect(sql).toContain('CREATE UNIQUE INDEX "conversation_whatsapp_connection_id_chat_key_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "message_conversation_id_external_message_id_key"');
    expect(sql).toContain('DROP COLUMN "whatsapp_connection_id"');
    expect(sql).not.toContain('ADD COLUMN "whatsapp_connection_id"');
  });

  it("merges split threads and dedupes tags before the new unique", () => {
    expect(sql).toContain("conversation_merge_map");
    expect(sql).toContain("DELETE FROM \"conversation_tag\" AS absorbee");
    expect(sql).toContain('DELETE FROM "message" AS absorbee');
    expect(sql).toContain("DELETE FROM \"conversation\" AS row");
    expect(sql).toContain('DROP INDEX "conversation_whatsapp_connection_id_remote_jid_key"');
    expect(sql.indexOf('DELETE FROM "conversation" AS row')).toBeLessThan(
      sql.indexOf('SET "remote_jid" = map.latest_remote_jid'),
    );
  });

  it("documents a fixture that the old unique-only schema would accept", () => {
    expect(oldIngest).toContain('CREATE UNIQUE INDEX "conversation_whatsapp_connection_id_remote_jid_key"');
    expect(oldIngest).not.toContain("conversation_chat_key_format");
    expect(fixture).toContain("5511999999999@s.whatsapp.net");
    expect(fixture).toContain("5511999999999@c.us");
    expect(fixture).toContain("rejected by conversation_chat_key_format");
    expect(fixture).toContain("two inbox rows");
    expect(fixture).toContain('INSERT INTO "conversation"');
    expect(fixture).toContain("'m-surv'");
    expect(fixture).toContain("'m-abs'");
  });
});

describe.skipIf(!live)("conversation chat_key migration (executed)", () => {
  let client: Client | null = null;
  let schemaName = "";

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("expected DATABASE_URL when live describe runs");
    }

    client = new Client({ connectionString });
    await client.connect();
    schemaName = `merge_test_${randomUUID().replace(/-/g, "")}`;
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

  it("merges the split pair onto the earlier conversation and rejects a JID as chat_key", async () => {
    const pg = client;
    if (!pg) {
      throw new Error("expected pg client after beforeAll");
    }

    await execSql(pg, fixture);

    const beforePair = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "conversation" WHERE "whatsapp_connection_id" = 'merge-conn'`,
    );
    expect(beforePair.rows[0]?.n).toBe("2");

    await pg.query(`
      INSERT INTO "conversation" (
        "id", "whatsapp_connection_id", "remote_jid", "customer_phone_normalized",
        "started_at", "last_message_at", "created_at", "updated_at"
      ) VALUES (
        'probe-jid-phone', 'merge-conn', '5511888888888@s.whatsapp.net',
        '5511999999999@s.whatsapp.net',
        TIMESTAMP '2026-01-04 00:00:00', TIMESTAMP '2026-01-04 00:00:00',
        TIMESTAMP '2026-01-04 00:00:00', TIMESTAMP '2026-01-04 00:00:00'
      )
    `);
    await pg.query(`DELETE FROM "conversation" WHERE id = 'probe-jid-phone'`);

    await execSql(pg, sql);

    const after = await pg.query<{
      id: string;
      chat_key: string;
      remote_jid: string;
      created_at_matches: boolean;
    }>(
      `SELECT id, chat_key, remote_jid,
              (created_at = TIMESTAMP '2026-01-01 00:00:00') AS created_at_matches
       FROM "conversation"
       WHERE "whatsapp_connection_id" = 'merge-conn' AND chat_key = '5511999999999'
       ORDER BY id`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.id).toBe("surv");
    expect(after.rows[0]?.remote_jid).toBe("5511999999999@c.us");
    expect(after.rows[0]?.created_at_matches).toBe(true);

    const messages = await pg.query<{ conversation_id: string; external_message_id: string }>(
      `SELECT conversation_id, external_message_id FROM "message" ORDER BY external_message_id`,
    );
    expect(messages.rows).toEqual([
      { conversation_id: "surv", external_message_id: "m-abs" },
      { conversation_id: "surv", external_message_id: "m-surv" },
    ]);

    const tags = await pg.query<{ conversation_id: string; tag_id: string }>(
      `SELECT conversation_id, tag_id FROM "conversation_tag"`,
    );
    expect(tags.rows).toEqual([{ conversation_id: "surv", tag_id: "tag-1" }]);

    try {
      await pg.query(`
        INSERT INTO "conversation" (
          "id", "whatsapp_connection_id", "remote_jid", "chat_key",
          "started_at", "last_message_at", "created_at", "updated_at"
        ) VALUES (
          'probe-check', 'merge-conn', '5511777777777@s.whatsapp.net',
          '5511999999999@s.whatsapp.net',
          TIMESTAMP '2026-01-05 00:00:00', TIMESTAMP '2026-01-05 00:00:00',
          TIMESTAMP '2026-01-05 00:00:00', TIMESTAMP '2026-01-05 00:00:00'
        )
      `);
      expect.fail("expected conversation_chat_key_format CHECK to reject the insert");
    } catch (error) {
      expect(pgConstraint(error)).toBe("conversation_chat_key_format");
    }
  }, 120_000);
});
