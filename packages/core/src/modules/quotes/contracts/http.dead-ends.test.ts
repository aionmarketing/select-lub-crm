/**
 * Test design (testing-strategy) — the attendant's ways out of the three dead ends (task 5.7)
 *
 * SUT: the quote-options union and the two D24 routes' bodies and answers, as zod parses them.
 * Pure: no database, no app.
 *
 * Oracle: the `shared-types` delta of background-oil-research — "Quote options carry what the
 *   attendant needs to resolve a dead end" (every scenario, one `it` each) and the engine re-read
 *   scenarios of "Quote options carry the research state"; design D24 F1, F2, F7.
 *
 * Cells (scenario | expected | the bug it would miss)
 *   no_capacity with one card and filters        | parses   | the card data dropped by the schema
 *   no_capacity carrying fillLiters               | rejected | a missing volume priced from nowhere
 *   options with attendantFill, no litersSource  | parses   | a stored volume the dialog cannot read
 *   options with both volume sources             | rejected | a cited and a typed volume mixed
 *   options with neither                          | rejected | a priced card with no source
 *   attendantFill priced other than in-service    | rejected | the field's in-service meaning lost
 *   grade conflict with cards                     | parses   | conflict cards stripped on parse
 *   volume conflict with its choices              | parses   | choices stripped
 *   agreed volume and choices together            | rejected | two volumes for one card
 *   old-shape conflict                            | parses, no cards | old rows failing the list
 *   partial card data                             | rejected | a half-written payload served
 *   grade conflict, no stated volume (+ kept one) | parses   | a dead end with no way out (orchestrator 2026-10-01)
 *   kept volume beside a stated one / old shape   | rejected | two volumes for one card
 *   engine re-read with engine and 1–2            | parses   | the dialog's re-read sentence
 *   engine re-read without engine                 | rejected | "Lendo a fonte para o motor …" blank
 *   engine re-read with another range             | rejected | a range shown for a re-read
 *   engine on another path                        | rejected | a stray engine
 *   volume choice with fillCondition dry          | rejected | a dry volume priced
 *   the engine-pick refusals                      | distinct | one 409 for two reasons
 *   fill volume 0 / negative / 4,255 / text       | rejected | a non-volume stored
 *   fill volume 42 with and without confirmation  | both parse; the 422 is the route's (D24 F7)
 */
import { describe, expect, it } from "vitest";
import {
  attendantFillSchema,
  enginePickBodySchema,
  enginePickRefusalSchema,
  highVolumeWarningSchema,
  incompleteIdentityRefusalSchema,
  oilFillVolumeBodySchema,
  versionTooLongSchema,
} from "./http.oil-attendant-fill.js";
import {
  gradeConflictWithCardsFixture,
  noCapacityWithCardsFixture,
  quoteOptionsWithFiltersFixture,
  volumeConflictWithCardsFixture,
} from "./http.fixtures.js";
import { quoteOptionsResultSchema } from "./http.oil-quote.js";

const parses = (payload: unknown) => quoteOptionsResultSchema.safeParse(payload).success;

const ATTENDANT_FILL = { liters: 4.2, recordedBy: "Marina", recordedAt: "2026-09-20T13:00:00.000Z" };

/** The options fixture priced from a stored attendant volume instead of a cited one. */
function attendantOptions() {
  const { litersSource, ...rest } = quoteOptionsWithFiltersFixture;
  void litersSource;
  return { ...rest, fillLiters: 4.2, fillKind: "em_servico", fillCondition: "with_filter", attendantFill: ATTENDANT_FILL };
}

const ENGINE_TIMING = {
  status: "researching",
  requestedAt: "2026-09-30T17:00:00.000Z",
  now: "2026-09-30T17:00:05.000Z",
  expectedMinutes: { min: 1, max: 2 },
  queuePosition: 0,
  path: "engine_pick",
  engine: "1.8 Dual VVT-i",
  paused: null,
};

describe("a missing volume", () => {
  it("parses with its cards and filters", () => {
    expect(parses(noCapacityWithCardsFixture)).toBe(true);
  });

  it("is rejected when it carries a volume", () => {
    expect(parses({ ...noCapacityWithCardsFixture, fillLiters: 4 })).toBe(false);
  });
});

describe("options priced from a stored attendant volume", () => {
  it("parse with attendantFill, fillLiters equal to it and no litersSource", () => {
    const parsed = quoteOptionsResultSchema.parse(attendantOptions());

    expect(parsed).toMatchObject({ status: "options", fillLiters: 4.2, attendantFill: ATTENDANT_FILL });
    expect(parsed).not.toHaveProperty("litersSource");
  });

  it("are rejected with both a cited and an attendant volume, and with neither", () => {
    const { attendantFill, ...neither } = attendantOptions();
    void attendantFill;

    expect(parses({ ...attendantOptions(), litersSource: quoteOptionsWithFiltersFixture.litersSource })).toBe(false);
    expect(parses(neither)).toBe(false);
  });

  it("are rejected when the stored volume is not priced as in-service with the filter", () => {
    expect(parses({ ...attendantOptions(), fillLiters: 4 })).toBe(false);
    expect(parses({ ...attendantOptions(), fillKind: "unlabeled" })).toBe(false);
    expect(parses({ ...attendantOptions(), fillCondition: "unlabeled" })).toBe(false);
  });
});

describe("a conflict with its card data", () => {
  it("a grade conflict carries cards, each with its grade's source", () => {
    const parsed = quoteOptionsResultSchema.parse(gradeConflictWithCardsFixture);

    expect(parsed).toMatchObject({ status: "conflicting_sources", options: [{ gradeSource: { sourcePublisher: "CarroRac", sourceUrl: null, sourceClassification: null } }] });
  });

  it("a volume conflict carries its choices", () => {
    const parsed = quoteOptionsResultSchema.parse(volumeConflictWithCardsFixture);

    expect(parsed).toMatchObject({ volumeChoices: [{ liters: 4.3 }, { liters: 4 }] });
  });

  it("is rejected with both an agreed volume and volume choices", () => {
    expect(parses({ ...volumeConflictWithCardsFixture, fillLiters: 4, fillKind: "em_servico", fillCondition: "with_filter", litersSource: gradeConflictWithCardsFixture.litersSource })).toBe(false);
  });

  it("is rejected with half its card data, or a single volume choice", () => {
    const { filters, ...noFilters } = gradeConflictWithCardsFixture;
    void filters;

    expect(parses(noFilters)).toBe(false);
    expect(parses({ ...volumeConflictWithCardsFixture, volumeChoices: volumeConflictWithCardsFixture.volumeChoices.slice(0, 1) })).toBe(false);
  });

  // Orchestrator, 2026-10-01: a grade conflict no source stated a usable volume for still has a way
  // out — the grade choice and a typed (or kept) volume, as on no_capacity.
  it("parses a grade conflict with no stated volume, alone or with a kept attendant volume", () => {
    const { fillLiters, fillKind, fillCondition, litersSource, ...noVolume } = gradeConflictWithCardsFixture;
    void [fillLiters, fillKind, fillCondition, litersSource];

    expect(parses(noVolume)).toBe(true);
    expect(quoteOptionsResultSchema.parse({ ...noVolume, attendantFill: ATTENDANT_FILL })).toMatchObject({ attendantFill: ATTENDANT_FILL });
  });

  it("rejects a kept attendant volume beside a stated one, or on an old-shape conflict", () => {
    expect(parses({ ...gradeConflictWithCardsFixture, attendantFill: ATTENDANT_FILL })).toBe(false);
    expect(parses({ ...volumeConflictWithCardsFixture, attendantFill: ATTENDANT_FILL })).toBe(false);
    expect(parses({ status: "conflicting_sources", conflicts: gradeConflictWithCardsFixture.conflicts, attendantFill: ATTENDANT_FILL })).toBe(false);
  });

  it("parses with no stocked oil for any disputed grade: no cards", () => {
    expect(parses({ ...gradeConflictWithCardsFixture, options: [] })).toBe(true);
  });

  it("a conflict in the old shape parses without cards", () => {
    const parsed = quoteOptionsResultSchema.parse({ status: "conflicting_sources", conflicts: gradeConflictWithCardsFixture.conflicts });

    expect(parsed).not.toHaveProperty("options");
  });

  it("a volume choice outside the priced fill conditions is rejected", () => {
    const [first, second] = volumeConflictWithCardsFixture.volumeChoices;

    expect(parses({ ...volumeConflictWithCardsFixture, volumeChoices: [first, { ...second, fillCondition: "dry" }] })).toBe(false);
  });
});

describe("an engine re-read", () => {
  it("parses with its engine and the fixed estimate", () => {
    expect(parses(ENGINE_TIMING)).toBe(true);
  });

  it("is rejected without its engine", () => {
    const { engine, ...withoutEngine } = ENGINE_TIMING;
    void engine;

    expect(parses(withoutEngine)).toBe(false);
  });

  it("is rejected with any estimate but 1–2 minutes, and an engine is rejected on another path", () => {
    expect(parses({ ...ENGINE_TIMING, expectedMinutes: { min: 1, max: 5 } })).toBe(false);
    expect(parses({ ...ENGINE_TIMING, path: "search" })).toBe(false);
  });

  it("is rejected as an options result's refresh without its engine", () => {
    const { status, engine, ...timing } = ENGINE_TIMING;
    void status;
    void engine;

    expect(parses({ ...quoteOptionsWithFiltersFixture, refresh: { ...timing, engine: "1.6" } })).toBe(true);
    expect(parses({ ...quoteOptionsWithFiltersFixture, refresh: timing })).toBe(false);
  });
});

describe("the two routes' bodies and answers", () => {
  it("the engine-pick refusals are distinct", () => {
    expect(enginePickRefusalSchema.parse({ reason: "not_clarification" })).toEqual({ reason: "not_clarification" });
    expect(enginePickRefusalSchema.parse({ reason: "engine_not_named" })).toEqual({ reason: "engine_not_named" });
    expect(enginePickRefusalSchema.parse({ reason: "version_changed" })).toEqual({ reason: "version_changed" });
    expect(enginePickRefusalSchema.safeParse({ reason: "other" }).success).toBe(false);
    expect(versionTooLongSchema.parse({ error: "version_too_long" })).toEqual({ error: "version_too_long" });
    expect(enginePickBodySchema.safeParse({ engine: " " }).success).toBe(false);
  });

  // Orchestrator, 2026-10-01: the store's DECIMAL(6,2) holds at most 9999.99.
  it.each([0, -1, 4.255, "4,2", 10_000])("a volume that is not positive with two decimals, up to 9999.99, is refused: %s", (liters) => {
    expect(oilFillVolumeBodySchema.safeParse({ liters }).success).toBe(false);
  });

  it("4,25 and a high volume, with or without its confirmation, parse: the warning is the route's", () => {
    expect(oilFillVolumeBodySchema.safeParse({ liters: 4.25 }).success).toBe(true);
    expect(oilFillVolumeBodySchema.safeParse({ liters: 9999.99, confirmHighVolume: true }).success).toBe(true);
    expect(oilFillVolumeBodySchema.safeParse({ liters: 42 }).success).toBe(true);
    expect(oilFillVolumeBodySchema.safeParse({ liters: 42, confirmHighVolume: true }).success).toBe(true);
    expect(highVolumeWarningSchema.parse({ warning: "high_volume" })).toEqual({ warning: "high_volume" });
    expect(incompleteIdentityRefusalSchema.parse({ reason: "incomplete_identity" })).toEqual({ reason: "incomplete_identity" });
    expect(attendantFillSchema.parse(ATTENDANT_FILL)).toEqual(ATTENDANT_FILL);
  });
});
