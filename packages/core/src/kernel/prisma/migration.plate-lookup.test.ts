/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk; Prisma DMMF for PlateLookup / PlateLookupCall.
 *
 * Oracle: add-plate-lookup task 3.1 — cache keyed on normalized plate plus a
 * billed-call ledger, additive migration, no change to Vehicle.
 *
 * Axes
 * A1 SQL — CREATE TABLE plate_lookup / plate_lookup_call
 * A2 DMMF — unique plate; PlateLookupCall has no unique plate
 *
 * Outputs: O1 tokens present; O2 DMMF unique / index
 *
 * Out of scope: live migrate (operator step, task 7.4). Conversation.prefillExtractEnabled
 * must remain on the model (unrelated change already on this branch).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260905220000_plate_lookup/migration.sql",
  ),
  "utf8",
);

describe("plate_lookup migration", () => {
  it("creates plate_lookup and plate_lookup_call tables", () => {
    expect(sql).toContain('CREATE TABLE "plate_lookup"');
    expect(sql).toContain('CREATE TABLE "plate_lookup_call"');
    expect(sql).toContain('CREATE UNIQUE INDEX "plate_lookup_plate_key"');
    expect(sql).toContain('CREATE INDEX "plate_lookup_call_plate_idx"');
    expect(sql).not.toContain("vehicle");
  });

  it("exposes PlateLookup keyed on plate and a PlateLookupCall ledger", () => {
    const lookup = Prisma.dmmf.datamodel.models.find((model) => model.name === "PlateLookup");
    const call = Prisma.dmmf.datamodel.models.find((model) => model.name === "PlateLookupCall");
    const conversation = Prisma.dmmf.datamodel.models.find((model) => model.name === "Conversation");

    expect(lookup?.fields.find((row) => row.name === "plate")?.isUnique).toBe(true);
    expect(lookup?.fields.find((row) => row.name === "rawPayload")?.type).toBe("Json");
    expect(call?.fields.find((row) => row.name === "plate")?.isUnique).toBeFalsy();
    expect(call?.fields.find((row) => row.name === "unitId")?.isRequired).toBe(false);
    expect(conversation?.fields.find((row) => row.name === "prefillExtractEnabled")?.isRequired).toBe(
      true,
    );
  });
});
