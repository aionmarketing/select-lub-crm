/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk; Prisma DMMF for the Conversation field.
 * Live insert when DATABASE_URL is set (skipIf otherwise).
 *
 * Oracle: prefill-switch-realistic-workshop-mix task 1.1 / design D1 —
 * `prefill_extract_enabled` boolean NOT NULL default false on conversation.
 *
 * Axes
 *   A1 SQL — ADD COLUMN with DEFAULT false vs missing / nullable without default
 *   A2 DMMF — field name / default / isRequired
 *   A3 live insert omit the column — reads false vs true/null
 *
 * Outputs: O1 tokens present; O2 DMMF default false; O3 row.prefillExtractEnabled === false
 *
 * Sampled-cell
 *   migration SQL DEFAULT false     | A1 | O1 | missing name or DEFAULT true
 *   DMMF Conversation field         | A2 | O2 | optional or default true
 *   new conversation omit column    | A3 | O3 | true or null (skipIf no URL)
 *
 * Out of scope: HTTP/worker (later tasks); backfill of existing rows (DEFAULT
 * false already stamps them).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260905180000_prefill_extract_enabled/migration.sql",
  ),
  "utf8",
);

const envPath = resolve(import.meta.dirname, "../../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const hasDatabase = Boolean(process.env.DATABASE_URL);
const P = "pexlive";

describe("prefill_extract_enabled migration", () => {
  it("adds a not-null boolean defaulting to false", () => {
    expect(sql).toContain(
      'ALTER TABLE "conversation" ADD COLUMN "prefill_extract_enabled" BOOLEAN NOT NULL DEFAULT false',
    );
  });

  it("exposes Conversation.prefillExtractEnabled default false on the Prisma model", () => {
    const field = Prisma.dmmf.datamodel.models
      .find((model) => model.name === "Conversation")
      ?.fields.find((row) => row.name === "prefillExtractEnabled");

    expect(field?.isRequired).toBe(true);
    expect(field?.hasDefaultValue).toBe(true);
    expect(field?.type).toBe("Boolean");
    expect(field?.default).toBe(false);
  });
});

describe.skipIf(!hasDatabase)("prefillExtractEnabled default on a new conversation", () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.whatsAppConnection.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.unit.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.$disconnect();
  });

  it("reads false when the insert omits the column", async () => {
    await prisma.unit.upsert({
      where: { id: `${P}-unit` },
      create: { id: `${P}-unit`, name: "Prefill extract" },
      update: {},
    });
    await prisma.whatsAppConnection.upsert({
      where: { id: `${P}-conn` },
      create: {
        id: `${P}-conn`,
        unitId: `${P}-unit`,
        instanceName: `${P}-instance`,
      },
      update: {},
    });
    await prisma.conversation.deleteMany({ where: { id: `${P}-conv` } });
    const row = await prisma.conversation.create({
      data: {
        id: `${P}-conv`,
        whatsappConnectionId: `${P}-conn`,
        remoteJid: "5519999990010@s.whatsapp.net",
        chatKey: "5519999990010",
        startedAt: new Date("2026-09-05T12:00:00.000Z"),
        lastMessageAt: new Date("2026-09-05T12:00:00.000Z"),
      },
      select: { prefillExtractEnabled: true },
    });

    expect(row.prefillExtractEnabled).toBe(false);
  });
});
