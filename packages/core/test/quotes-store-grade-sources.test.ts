/**
 * Test design (testing-strategy) — quotes store, per-grade provenance
 *
 * Lives in packages/core/test because it reads the store, an `internal/` of the quotes
 * module, on the test database harness — which neither a slice test nor `internal/` may
 * import.
 *
 * SUT: the Prisma store's `latestCompatibility` / `insertCompatibility`, read directly on a
 *   rolling-back transaction — below the quote path, so nothing there can stand in for what
 *   the store fails to derive.
 *
 * Oracle: oil-quote spec "Each grade and the liters carry their own source", scenario "An
 *   older cache row keeps its single source"; design D11 — a row written before
 *   `grade_sources` (NULL) reads as one provenance, its `source_*` columns, for every grade
 *   and the liters; `litersSource` is null exactly when there are no liters.
 *
 * Why here and not through `getQuoteOptions`: the quote path falls back to the primary
 *   source when a row lacks a liters source (orchestrator ruling, 2026-09-25), so a store
 *   that stopped deriving it would still show the right answer there. Only a read of the
 *   store itself sees the difference.
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeWithDatabase, withTestTransaction } from "../src/testing/index.js";
import type { DbClient } from "../src/kernel/db.js";
import { createPrismaOilQuoteStore } from "../src/modules/quotes/internal/store/prisma.js";

const PRIMARY = {
  sourcePublisher: "Volkswagen do Brasil",
  sourceDocument: "Manual do Proprietário Polo 2021",
  sourcePage: "p. 287",
  sourceAuthority: 1,
  sourceUrl: "https://www.vw.com.br/manual-polo.pdf",
  sourceClassification: "manufacturer_manual" as const,
  sourceExcerpt: "Use óleo SAE 5W-40 ou 5W-30; 4,0 L com filtro.",
};

/** An identity no other row holds, so `latestCompatibility` can only read this case's row. */
function uniqueIdentity() {
  return { make: "VW", year: 2021, model: "Polo", version: `1.0 TSI ${randomUUID().slice(0, 8)}` };
}

/**
 * Writes a row the way it looked before `grade_sources` existed (the column left NULL), or,
 * with `gradeSources`, a row whose column holds that value as written by hand.
 */
async function insertPreColumnRow(
  tx: DbClient,
  identity: ReturnType<typeof uniqueIdentity>,
  liters: number | null,
  gradeSources?: object,
) {
  return tx.motulCompatibility.create({
    select: { id: true },
    data: {
      ...(gradeSources ? { gradeSources } : {}),
      ...identity,
      viscosities: ["5W-40", "5W-30"],
      viscosity: "5W-40",
      classification: "",
      fillLiters: liters,
      fillKind: liters == null ? null : "em_servico",
      ...PRIMARY,
      consultedAt: new Date("2026-09-01T12:00:00.000Z"),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The `console.warn` lines about unreadable provenance, parsed. */
function provenanceWarnings(warn: { mock: { calls: unknown[][] } }) {
  return warn.mock.calls
    .filter((call) => String(call[1] ?? "").includes("grade_sources_unreadable"))
    .map((call) => ({ raw: call.join(" "), entry: JSON.parse(String(call[1])) as Record<string, unknown> }));
}

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

describeWithDatabase("oil quote store — per-grade provenance", () => {
  itInTx("reads a pre-column row's liters as cited to its own source", async (tx) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const identity = uniqueIdentity();
    await insertPreColumnRow(tx, identity, 4);

    const row = await createPrismaOilQuoteStore(tx).latestCompatibility(identity);

    // NULL is an old row, not a damaged one: nothing to warn about.
    expect(provenanceWarnings(warn)).toEqual([]);
    expect(row?.litersSource).toEqual(PRIMARY);
    expect(row?.gradeSources).toEqual([
      { grade: "5W-40", ...PRIMARY },
      { grade: "5W-30", ...PRIMARY },
    ]);
  });

  itInTx("gives a pre-column row with no liters no liters source", async (tx) => {
    const identity = uniqueIdentity();
    await insertPreColumnRow(tx, identity, null);

    const row = await createPrismaOilQuoteStore(tx).latestCompatibility(identity);

    expect(row?.litersSource).toBeNull();
    expect(row?.gradeSources).toHaveLength(2);
  });

  itInTx("reads back the provenance it wrote", async (tx) => {
    const identity = uniqueIdentity();
    const catalog = {
      sourcePublisher: "CarroRac",
      sourceDocument: "Tabela de aplicação",
      sourcePage: "Polo AW",
      sourceAuthority: 5,
      sourceUrl: null,
      sourceClassification: "aftermarket_catalog" as const,
      sourceExcerpt: "5W-40 ou 5W-30, 4,0 L",
    };
    const store = createPrismaOilQuoteStore(tx);

    const written = await store.insertCompatibility({
      ...identity,
      viscosityGrades: ["5W-40", "5W-30"],
      viscosity: "5W-40",
      classification: "",
      fillLiters: 4,
      fillKind: "em_servico",
      consultedAt: "2026-09-25T12:00:00.000Z",
      rawPayload: null,
      ...PRIMARY,
      gradeSources: [
        { grade: "5W-40", ...PRIMARY },
        { grade: "5W-30", ...catalog },
      ],
      litersSource: catalog,
    });

    expect(written.gradeSources).toEqual([
      { grade: "5W-40", ...PRIMARY },
      { grade: "5W-30", ...catalog },
    ]);
    expect(written.litersSource).toEqual(catalog);
    expect(await store.latestCompatibility(identity)).toEqual(written);
  });

  // Orchestrator review of #175: a damaged value still reads — no 500 — but warns, naming the
  // row and never the excerpt, because its fallback may cite a grade to a source not listing it.
  itInTx("reads an unparseable value with the primary source, and warns naming the row", async (tx) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const identity = uniqueIdentity();
    const { id } = await insertPreColumnRow(tx, identity, 4, { grades: "not a list", liters: 7 });

    const row = await createPrismaOilQuoteStore(tx).latestCompatibility(identity);

    expect(row?.gradeSources?.map((entry) => entry.sourcePublisher)).toEqual([PRIMARY.sourcePublisher, PRIMARY.sourcePublisher]);
    const warnings = provenanceWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.entry).toMatchObject({ compatibilityId: id, reason: "invalid_shape", gradesCitedToPrimary: ["5W-40", "5W-30"] });
    expect(warnings[0]!.raw).not.toContain(PRIMARY.sourceExcerpt);
  });

  itInTx("warns when a parsed value does not list one of the row's grades", async (tx) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const identity = uniqueIdentity();
    const catalog = { publisher: "CarroRac", document: "Tabela", page: "Polo", authority: 5, url: null, classification: null, excerpt: "5W-40, 4 L" };
    const { id } = await insertPreColumnRow(tx, identity, 4, { grades: [{ grades: ["5W-40"], ...catalog }], liters: catalog });

    const row = await createPrismaOilQuoteStore(tx).latestCompatibility(identity);

    expect(row?.gradeSources?.map((entry) => entry.sourcePublisher)).toEqual(["CarroRac", PRIMARY.sourcePublisher]);
    const warnings = provenanceWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.entry).toMatchObject({ compatibilityId: id, reason: "grades_not_listed", gradesCitedToPrimary: ["5W-30"] });
    expect(warnings[0]!.raw).not.toContain(catalog.excerpt);
  });
});
