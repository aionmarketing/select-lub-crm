/**
 * Test design (testing-strategy)
 *
 * Setup: pure helpers in vehicle-plate.ts. No HTTP, no DOM.
 *
 * Oracle: add-plate-lookup plate-lookup spec — blur-only lookup, silent fill
 * when all four identity fields are empty, confirm when they would change,
 * noop when equal, keep clears marks, declined suggestion keys are omitted
 * from the create body.
 *
 * Axes
 *   A1 plate text — malformed / valid new / same as stored / same as last found / last failed
 *   A2 identity — all empty / equal to suggestion / different
 *   A3 declined keys — none / version unchecked
 *   A4 plate FORMAT — old `ABC1234` / Mercosul `ABC1D23` / neither
 *     (added 2026-09-07, session 7: plate-lookup/spec.md line 10 requires
 *     BOTH formats, and only Mercosul was sampled. The `PLATE` regex is an
 *     alternation `(?:[A-Z]\d{2}|\d{3})` whose second arm — the old format —
 *     had no input reaching it, so a regex edited down to Mercosul-only
 *     would have passed the whole suite while silently rejecting every
 *     pre-2018 plate and sending the attendant to manual entry.)
 *   A5 last-completed STATUS — found / not_found / failed / unavailable
 *     (added 2026-09-07, session 7: the retry decision reads
 *     `lastCompleted.status === "failed"`, so `failed` sampled its TRUE side
 *     and `found` its FALSE side while `not_found` and `unavailable` — both
 *     reachable, both produced by `vehicle-plate-fields.tsx:43` — went
 *     unsampled. `unavailable` is the one worth pinning: the docstring on
 *     `shouldLookupOnPlateBlur` USED to claim "a failed or unavailable
 *     previous lookup is retried", contradicting the code, which retries
 *     only `failed`. Ruled on 2026-09-07 that the code is right and the
 *     comment was the defect — plate-lookup/spec.md:67 scopes the retry to a
 *     lookup that "failed on a provider error", while :255 makes
 *     `unavailable` mean no APIBrasil credentials are configured, a static
 *     condition re-blurring cannot change. The comment is fixed and these
 *     two cases stop it drifting back.)
 *
 * Outputs: lookup plate or null; silent-fill / confirm / noop; create body keys
 *
 * Sampled-cell
 *   malformed                         | A1 bad            | null | a lookup plate
 *   unchanged stored                  | A1 same stored    | null | ABC1D23
 *   changed valid                     | A1 new            | ABC1D23 | null
 *   repeat found                      | A1 last found     | null | lookup
 *   last failed same plate            | A1 last failed    | ABC1D23 | null
 *   empty identity                    | A2 empty          | silent-fill | confirm
 *   equal suggestion                  | A2 equal          | noop | confirm
 *   different filled                  | A2 different      | confirm | silent-fill
 *   declined version                  | A3 version        | body omits version | version sent
 *   old-format plate                  | A4 old            | ABC1234 | null — fails if
 *                                       the alternation loses its `\d{3}` arm
 *   Mercosul with a digit 5th          | A4 neither        | null | a lookup plate —
 *                                       the near-miss BVA on format, one character
 *                                       from valid, where `ZZZZZZZ` is far from it
 *   not-found same plate               | A5 not_found      | null | a repeat lookup,
 *                                       which would bill a plate already answered
 *   unavailable same plate             | A5 unavailable    | null | a lookup — fails
 *                                       if the retry branch widens back to include
 *                                       an unconfigured capability
 *
 * Decision map (shouldLookupOnPlateBlur / decideFoundLookup / createBodyFromDraft)
 *   parsePlate null T: malformed it; F: the valid-plate its
 *   parsePlate `PLATE` alternation: `[A-Z]\d{2}` arm — the Mercosul its;
 *     `\d{3}` arm — the old-format it
 *   lastCompleted same plate T: found skip / failed retry; F: stored-unchanged / changed
 *   lastCompleted.status === "failed" T: the failed-retry it; F: the found,
 *     not-found and unavailable its — all three non-retrying members of the
 *     status domain now sampled, so the branch is closed over its inputs
 *     rather than over one representative
 *   stored === normalized && last null T: unchanged it; F: changed it
 *   changedKeys.length === 0 T: noop it; F: empty vs filled
 *   allIdentityEmpty T: silent-fill it; F: confirm it
 *   declined.has(version) T: omitted it; F: included when filled
 *
 * Out of scope: MSW / AddVehicleDialog (vehicles.plate.test.tsx). This file
 * does not assert upper-cased button labels (f2dbf2f is not on this branch;
 * MuiButton is still sentence case in the DOM).
 */
import { describe, expect, it } from "vitest";
import {
  createBodyFromDraft,
  decideFoundLookup,
  emptyVehicleDraft,
  overwriteFromSuggestion,
  parsePlate,
  shouldLookupOnPlateBlur,
} from "./vehicle-plate.js";

describe("parsePlate", () => {
  it("normalizes a hyphenated Mercosul plate", () => {
    expect(parsePlate("abc-1d23")).toBe("ABC1D23");
  });

  it("rejects a malformed plate", () => {
    expect(parsePlate("ZZZZZZZ")).toBeNull();
  });

  // A4, added 2026-09-07: plate-lookup/spec.md requires BOTH Brazilian
  // formats. The old format is the regex's other alternation arm and had no
  // test reaching it.
  it("normalizes an old-format plate", () => {
    expect(parsePlate("abc-1234")).toBe("ABC1234");
  });

  it("rejects a plate whose letter sits one position late", () => {
    // One character away from valid, unlike ZZZZZZZ: neither arm can match,
    // because position 5 must be a letter (Mercosul) or a digit followed by
    // two more digits (old).
    expect(parsePlate("ABC12D3")).toBeNull();
  });
});

describe("shouldLookupOnPlateBlur", () => {
  it("does not look up a malformed plate", () => {
    expect(shouldLookupOnPlateBlur("ABC", null, null)).toBeNull();
  });

  it("does not look up the plate already stored when nothing has been looked up yet", () => {
    expect(shouldLookupOnPlateBlur("ABC1D23", "ABC1D23", null)).toBeNull();
  });

  it("looks up a valid plate that differs from the stored one", () => {
    expect(shouldLookupOnPlateBlur("xyz9f88", "ABC1D23", null)).toBe("XYZ9F88");
  });

  it("does not repeat a found lookup of the same plate", () => {
    expect(
      shouldLookupOnPlateBlur("ABC1D23", null, { plate: "ABC1D23", status: "found" }),
    ).toBeNull();
  });

  it("retries after a failed lookup of the same plate", () => {
    expect(
      shouldLookupOnPlateBlur("ABC1D23", null, { plate: "ABC1D23", status: "failed" }),
    ).toBe("ABC1D23");
  });

  // A5, added 2026-09-07: `failed` was the only status reaching the retry
  // branch's TRUE side and `found` the only one reaching its FALSE side, so
  // the other two members of the status domain were unsampled. `unavailable`
  // is the one that matters — see the note on A5 in the header.
  it("does not repeat a not-found lookup of the same plate", () => {
    expect(
      shouldLookupOnPlateBlur("ABC1D23", null, { plate: "ABC1D23", status: "not_found" }),
    ).toBeNull();
  });

  it("does not retry an unavailable lookup of the same plate", () => {
    expect(
      shouldLookupOnPlateBlur("ABC1D23", null, { plate: "ABC1D23", status: "unavailable" }),
    ).toBeNull();
  });
});

describe("decideFoundLookup", () => {
  const suggestion = { make: "VW", model: "Gol", version: "1.0", year: 2020 };

  it("fills silently when all four identity fields are empty", () => {
    expect(
      decideFoundLookup({ make: "", model: "", version: "", year: "" }, suggestion),
    ).toMatchObject({
      action: "silent-fill",
      next: { make: "VW", model: "Gol", version: "1.0", year: "2020" },
      sourcedKeys: ["make", "model", "version", "year"],
    });
  });

  it("changes nothing when the suggestion equals the stored identity", () => {
    expect(
      decideFoundLookup(
        { make: "VW", model: "Gol", version: "1.0", year: "2020" },
        suggestion,
      ),
    ).toEqual({ action: "noop" });
  });

  it("asks for confirmation when a filled identity would change", () => {
    expect(
      decideFoundLookup(
        { make: "Honda", model: "Civic", version: "EXL", year: "2021" },
        suggestion,
      ),
    ).toMatchObject({
      action: "confirm",
      changing: ["make", "model", "version", "year"],
    });
  });
});

describe("overwriteFromSuggestion and createBodyFromDraft", () => {
  it("marks only the identity keys the suggestion actually filled", () => {
    expect(overwriteFromSuggestion({ make: "VW", model: "Gol", version: "", year: "2020" })).toEqual({
      sourcedKeys: ["make", "model", "year"],
    });
  });

  it("omits a declined suggestion key from the create body", () => {
    const draft = {
      ...emptyVehicleDraft(),
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: "2020",
    };

    expect(createBodyFromDraft(draft, ["make", "model", "version", "year"], ["version"])).toEqual({
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      year: 2020,
      plateSourcedKeys: ["make", "model", "year"],
    });
  });
});
