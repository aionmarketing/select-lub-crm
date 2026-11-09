/**
 * Test design (testing-strategy)
 *
 * Scope: the four DRAFT<->WIRE converters in `vehicle-plate.ts` —
 * `createBodyFromDraft`, `patchFromDraft`, `draftFromVehicle` and
 * `suggestionAsDraft`. No DOM, no HTTP.
 *
 * Why a separate file from `vehicle-plate.test.ts`: that file's header
 * declares its axes as the LOOKUP decision (blur gating, silent fill vs
 * confirm, declined keys). These are the write-body axes — blank vs filled
 * per column, and the omit-vs-null asymmetry between POST and PATCH.
 * Appending them there would have made that header's scope claim untrue,
 * and the standing instruction is to leave existing headers alone.
 *
 * Why these cases exist: the scoped coverage run of 2026-09-07 put
 * `vehicle-plate.ts` at 100% statements but 84.21% BRANCHES. That gap is the
 * signature of one-sided decisions — every line runs, but a whole side of
 * each `if`/ternary never does. Concretely, every pre-existing case built a
 * body from a FULLY POPULATED draft, so the blank side of all six columns,
 * both numeric coercions, and the `sourced.length > 0` guard had no input.
 *
 * Oracle: `customer-vehicles/spec.md:32` — "POST MAY omit plate, make,
 * model, version, year, and odometer; omitted fields SHALL be stored as
 * null" — plus the documented contrast on `patchFromDraft`, which sends
 * every displayed column explicitly (null when blank) rather than omitting
 * it, so an attendant CLEARING a field is not read as "no opinion" by the
 * omitted-key origin rules. That asymmetry is the point of testing the two
 * builders against the same blank draft: identical input, deliberately
 * different wire shapes.
 *
 * Axes
 *   A1 column value: filled / empty string / whitespace only
 *   A2 column kind: string (plate, make, model, version) / numeric-coerced
 *      (year, odometerKm) — different code paths, `text()` vs `Number()`
 *   A3 declined-vs-sourced overlap: a marked key that IS sent / a marked key
 *      whose column is blank / a marked key the attendant declined
 *   A4 builder: POST (omits) / PATCH (nulls)
 *
 * Outputs
 *   O1 the KEY SET of the body (which columns appear at all) — the output
 *      partition the spec actually constrains
 *   O2 the value and JS type under each key
 *   O3 presence or absence of `plateSourcedKeys`
 *
 * Sampled cells (one row per `it`)
 *   POST from a blank draft      | A1 empty, A4 POST | O1 {} | fails if any
 *                                  column is sent as "" or null
 *   POST from whitespace         | A1 blank, A4 POST | O1 {} | fails if trim
 *                                  is dropped and " " is sent
 *   POST odometer only           | A2 numeric        | O2 number | fails if the
 *                                  string "120000" reaches the wire
 *   POST year only               | A2 numeric        | O2 number | as above
 *   POST, marked key blank       | A3 blank+marked   | O3 key absent from
 *                                  plateSourcedKeys | fails if a column that
 *                                  was never sent is still claimed as sourced
 *   POST, only marked key        | A3 declined       | O3 no plateSourcedKeys
 *     declined                     property at all | fails if an empty array
 *                                  is emitted instead of the key being dropped
 *   PATCH from a blank draft     | A1 empty, A4 PATCH| O1 every column present
 *                                  and null | fails if PATCH starts OMITTING
 *                                  blanks, which would silently discard a clear
 *   PATCH from a filled draft    | A1 filled, A4     | O2 | fails if a numeric
 *                                  column stays a string
 *   draftFromVehicle, all null   | A1 empty          | O2 "" per column |
 *                                  fails if null reaches a controlled input
 *   draftFromVehicle, populated  | A1 filled         | O2 strings | fails if a
 *                                  number is handed to a text field unconverted
 *
 * Decision / branch map
 *   `createBodyFromDraft` `declined.has(key)`
 *     T — the declined `it`; F — every other `it`
 *   `createBodyFromDraft` `value.trim() === ""` inside `text`
 *     T — blank and whitespace its; F — the filled its
 *   `createBodyFromDraft` `if (make)` / `if (model)` / `if (version)` /
 *     `if (year)`
 *     T — the filled its; F — the blank its (all four at once)
 *   `createBodyFromDraft` `text(draft.plate) ? ... : {}`
 *     T — the filled its; F — the blank its
 *   `createBodyFromDraft` `year === undefined ? {} : ...`
 *     T — blank its; F — the year-only and filled its
 *   `createBodyFromDraft` `odometer === "" ? {} : ...`
 *     T — blank its; F — the odometer-only it
 *   `createBodyFromDraft` `sourced.length > 0`
 *     T — the marked-key-blank it (one survives); F — the all-declined it
 *   `patchFromDraft` six `trim() ? value : null` ternaries
 *     T — the filled PATCH it; F — the blank PATCH it
 *   `patchFromDraft` `year === "" ? null : Number(year)` and the odometer
 *     twin — T and F across the same two its
 *   `draftFromVehicle` `?? ""` on plate/make/model/version and the two
 *     `== null` ternaries — nullish side in the all-null it, value side in
 *     the populated it
 *   `suggestionAsDraft` `?? ""` on make/model/version and the `year == null`
 *     ternary — nullish side in the returned-nothing it, value side in the
 *     partial it (which takes make and year present, model and version
 *     absent, so both sides occur within one call)
 *
 * Out of scope, with reason
 *   - A year or odometer holding non-numeric text ("abc"). `Number()` would
 *     yield NaN, but both fields are `<input type="number">` in
 *     `vehicle-plate-fields.tsx`, and no spec says what a NaN column means.
 *     Reachable only by bypassing the form, and settling it here would
 *     invent a requirement.
 */
import { describe, expect, it } from "vitest";
import type { Vehicle } from "@select-lub/shared-types";
import {
  createBodyFromDraft,
  draftFromVehicle,
  emptyVehicleDraft,
  patchFromDraft,
  suggestionAsDraft,
} from "./vehicle-plate.js";

const FILLED = {
  plate: "ABC1D23",
  make: "VW",
  model: "Gol",
  version: "1.0",
  year: "2020",
  odometerKm: "120000",
};

/** A stored row with every optional column null — the create-time shape. */
function emptyVehicle(): Vehicle {
  return {
    id: "veh_1",
    customerId: "cus_1",
    omieId: null,
    plate: null,
    make: null,
    model: null,
    version: null,
    year: null,
    odometerKm: null,
    origin: "crm",
    plateSourcedKeys: [],
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  };
}

describe("createBodyFromDraft omits blank columns", () => {
  it("sends no columns at all for a wholly blank draft", () => {
    // customer-vehicles/spec.md:32 — omitted fields are stored as null, so
    // the builder must OMIT rather than send "" or null on create.
    expect(createBodyFromDraft(emptyVehicleDraft())).toEqual({});
  });

  it("treats whitespace-only columns as blank", () => {
    const draft = { plate: " ", make: "  ", model: "\t", version: " ", year: " ", odometerKm: " " };

    expect(createBodyFromDraft(draft)).toEqual({});
  });

  it("coerces a lone odometer to a number", () => {
    const draft = { ...emptyVehicleDraft(), odometerKm: "120000" };

    expect(createBodyFromDraft(draft)).toEqual({ odometerKm: 120000 });
  });

  it("coerces a lone year to a number", () => {
    const draft = { ...emptyVehicleDraft(), year: "2020" };

    expect(createBodyFromDraft(draft)).toEqual({ year: 2020 });
  });

  it("sends all six columns when the draft is complete and nothing is declined", () => {
    // The only case in which `version` is actually SENT: the pre-existing
    // suite either left it blank or declined it, so `if (version)` and its
    // spread had no true side. Also the sole full-body shape — every other
    // case here is deliberately sparse.
    expect(createBodyFromDraft(FILLED, ["make", "version"])).toEqual({
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: 2020,
      odometerKm: 120000,
      plateSourcedKeys: ["make", "version"],
    });
  });
});

describe("createBodyFromDraft reconciles marks against what is actually sent", () => {
  it("does not claim a blank column as plate-sourced", () => {
    // `model` is marked but empty, so it is never sent; claiming it would
    // mark a column the row does not have.
    const draft = { ...emptyVehicleDraft(), make: "VW" };

    expect(createBodyFromDraft(draft, ["make", "model"])).toEqual({
      make: "VW",
      plateSourcedKeys: ["make"],
    });
  });

  it("drops plateSourcedKeys entirely when every marked column was declined", () => {
    const draft = { ...emptyVehicleDraft(), make: "VW" };

    expect(createBodyFromDraft(draft, ["make"], ["make"])).toEqual({});
  });
});

describe("patchFromDraft sends every column, null when blank", () => {
  it("nulls each displayed column rather than omitting it", () => {
    // The deliberate contrast with the create body: an omitted key means "no
    // opinion" to the origin rules, so a PATCH must say null to record that
    // the attendant cleared the field.
    expect(patchFromDraft(emptyVehicleDraft(), [])).toEqual({
      plate: null,
      make: null,
      model: null,
      version: null,
      year: null,
      odometerKm: null,
      plateSourcedKeys: [],
    });
  });

  it("sends filled columns with the numeric ones coerced", () => {
    expect(patchFromDraft(FILLED, ["make"])).toEqual({
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: 2020,
      odometerKm: 120000,
      plateSourcedKeys: ["make"],
    });
  });
});

describe("suggestionAsDraft fills only what the lookup returned", () => {
  it("maps a suggestion that returned nothing to four empty strings", () => {
    // Every field of `plateSuggestionFieldsSchema` is `.optional()`, so a
    // provider answering with no identity at all is a legal `found` payload
    // rather than a malformed one.
    expect(suggestionAsDraft({})).toEqual({ make: "", model: "", version: "", year: "" });
  });

  it("leaves the columns a partial suggestion omitted empty, and stringifies the year", () => {
    // plate-lookup/spec.md:160 — the plate-sourced mark covers a field whose
    // CURRENT VALUE came from the plate. A field the lookup never returned has
    // nothing to mark, and it reaches that rule as "" through this converter:
    // `decideFoundLookup` builds `sourcedKeys` by filtering out the empties.
    expect(suggestionAsDraft({ make: "VW", year: 2020 })).toEqual({
      make: "VW",
      model: "",
      version: "",
      year: "2020",
    });
  });
});

describe("draftFromVehicle", () => {
  it("renders every null column as an empty string", () => {
    // Controlled inputs cannot take null without React warning and losing
    // the value, so the draft shape has no nulls in it.
    expect(draftFromVehicle(emptyVehicle())).toEqual({
      plate: "",
      make: "",
      model: "",
      version: "",
      year: "",
      odometerKm: "",
    });
  });

  it("stringifies the numeric columns of a populated vehicle", () => {
    const vehicle: Vehicle = {
      ...emptyVehicle(),
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: 2020,
      odometerKm: 120000,
    };

    expect(draftFromVehicle(vehicle)).toEqual(FILLED);
  });
});
