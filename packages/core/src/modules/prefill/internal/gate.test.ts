/**
 * Test design (testing-strategy)
 *
 * Setup: gate.ts pure functions. No store, no OpenAI.
 *
 * Oracle: assistive-cadastro-prefill empty-field gate + post-filter
 * (name empty if blank or equal to normalized phone; extra keys dropped;
 * already-filled stored keys omitted).
 *
 * Axes
 *   A1 isBlank: null | undefined | "" | whitespace | non-blank
 *   A2 nameIsEmpty: blank | equal to phone | real name
 *   A3 hasEmptyV1Field: !customerId vs each v1 empty vs all filled
 *   A4 storedV1: placeholder name omitted; real name kept; year/odometer 0 vs null
 *   A5 pickV1Fields: keep vs drop (empty string, extra street, non-int year, non-number km)
 *   A6 postFilterFilled: stored key present vs absent vs stored value undefined
 *
 * Outputs: O-true, O-false, O-fields
 *
 * Sampled-cell
 *   isBlank null / undefined / "" / "  " / "x"
 *   nameIsEmpty phone match vs Ana
 *   hasEmpty each empty class + all filled
 *   storedV1 placeholder vs Ana; year 0 vs null
 *   pickV1 keep all v1; drop street/empty/non-int/non-number
 *   postFilter stored plate drops extracted plate; empty stored keeps it
 *
 * Decision map (gate.ts)
 *   D1 isBlank == null          T: null and undefined its; F: "x"
 *   D2 isBlank trim === ""      T: "" and "  "; F: "x" (null short-circuits)
 *   D3 nameIsEmpty isBlank      T: null name; F: phone-equal and Ana
 *   D4 nameIsEmpty === phone    T: phone-equal; F: Ana
 *   D5 hasEmpty !customerId     T: no-id it; F: field-empty / all-filled
 *   D6–D13 OR chain             T: one `it` per field empty; F: all-filled
 *   D14–D21 storedV1 ifs        T: filled snapshot; F: empty/placeholder
 *   D22 storedV1 `&& name` after !nameIsEmpty — F infeasible (blank already excluded)
 *   D23 postFilter stored[key]  T: stored plate; F: empty stored / undefined value
 *   D24 pickV1 string+trim      T: keep-all; F: empty / whitespace / non-string
 *   D25 pickV1 year int         T: 2020; F: 2020.5 (typeof number)
 *   D26 pickV1 odometer number  T: 0; F: "10"
 *
 * Out of scope: enqueue/drain (enqueue.test.ts / extract.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  hasEmptyV1Field,
  isBlank,
  nameIsEmpty,
  pickV1Fields,
  postFilterFilled,
  storedV1,
} from "./gate.js";
import type { PrefillCadastroSnapshot } from "./cadastro-snapshot.js";

const phoneNormalized = "5511999999999";

const filled: PrefillCadastroSnapshot = {
  customerId: "cus-1",
  phoneNormalized,
  name: "Ana Silva",
  taxId: "12345678901",
  plate: "ABC1D23",
  make: "VW",
  model: "Gol",
  version: "1.0",
  year: 2018,
  odometerKm: 40000,
  plateSourcedKeys: [],
};

function snapshot(patch: Partial<PrefillCadastroSnapshot> = {}): PrefillCadastroSnapshot {
  return { ...filled, ...patch };
}

describe("isBlank", () => {
  it.each([
    { value: null, expected: true }, // D1 T
    { value: undefined, expected: true }, // D1 T
    { value: "", expected: true }, // D2 T
    { value: "  ", expected: true }, // D2 T whitespace
    { value: "x", expected: false }, // D1 F D2 F
  ])("isBlank($value) → $expected", ({ value, expected }) => {
    expect(isBlank(value)).toBe(expected);
  });
});

describe("nameIsEmpty", () => {
  it("is empty when the name is blank", () => {
    expect(nameIsEmpty(null, phoneNormalized)).toBe(true);
  });

  it("is empty when the name equals the normalized phone", () => {
    expect(nameIsEmpty(phoneNormalized, phoneNormalized)).toBe(true);
  });

  it("is not empty when the name is a real given name", () => {
    expect(nameIsEmpty("Ana Silva", phoneNormalized)).toBe(false);
  });
});

describe("hasEmptyV1Field", () => {
  it.each([
    { label: "no customerId", patch: { customerId: null }, empty: true },
    { label: "placeholder name", patch: { name: phoneNormalized }, empty: true },
    { label: "blank taxId", patch: { taxId: "  " }, empty: true },
    { label: "blank plate", patch: { plate: "" }, empty: true },
    { label: "blank make", patch: { make: null }, empty: true },
    { label: "blank model", patch: { model: null }, empty: true },
    { label: "blank version", patch: { version: null }, empty: true },
    { label: "null year", patch: { year: null }, empty: true },
    { label: "null odometer", patch: { odometerKm: null }, empty: true },
    { label: "all v1 filled", patch: {}, empty: false },
  ] as const)("$label → empty=$empty", ({ patch, empty }) => {
    expect(hasEmptyV1Field(snapshot(patch))).toBe(empty);
  });
});

describe("storedV1", () => {
  it("omits a placeholder name and includes a real name", () => {
    expect(storedV1(snapshot({ name: phoneNormalized })).name).toBeUndefined();
    expect(storedV1(filled).name).toBe("Ana Silva");
  });

  it("includes year 0 and omits year null", () => {
    expect(storedV1(snapshot({ year: 0 })).year).toBe(0);
    expect(storedV1(snapshot({ year: null })).year).toBeUndefined();
  });

  it("includes odometer 0 and omits odometer null", () => {
    expect(storedV1(snapshot({ odometerKm: 0 })).odometerKm).toBe(0);
    expect(storedV1(snapshot({ odometerKm: null })).odometerKm).toBeUndefined();
  });
});

describe("pickV1Fields", () => {
  it("keeps trimmed v1 keys including year integer and odometer 0", () => {
    expect(
      pickV1Fields({
        name: " Ana ",
        taxId: "12345678901",
        plate: "ABC1D23",
        make: "VW",
        model: "Gol",
        version: "1.0",
        year: 2020,
        odometerKm: 0,
      }),
    ).toEqual({
      name: "Ana",
      taxId: "12345678901",
      plate: "ABC1D23",
      make: "VW",
      model: "Gol",
      version: "1.0",
      year: 2020,
      odometerKm: 0,
    });
  });

  it("drops a leaked street key", () => {
    expect(pickV1Fields({ plate: "ABC1D23", street: "Rua A" })).toEqual({ plate: "ABC1D23" });
  });

  it("drops a present empty name", () => {
    expect(pickV1Fields({ name: "" }).name).toBeUndefined();
  });

  it("drops a non-integer year", () => {
    expect(pickV1Fields({ year: 2020.5 }).year).toBeUndefined();
  });

  it("drops a non-number odometer", () => {
    expect(pickV1Fields({ odometerKm: "10" }).odometerKm).toBeUndefined();
  });
});

describe("postFilterFilled", () => {
  it("drops extracted keys that echo the stored value", () => {
    expect(postFilterFilled({ plate: "ABC1D23", make: "VW" }, { plate: "ABC1D23" })).toEqual({
      make: "VW",
    });
  });

  it("keeps extracted keys when stored is empty", () => {
    expect(postFilterFilled({ plate: "ABC1D23" }, {})).toEqual({ plate: "ABC1D23" });
  });

  it("drops a marked make even when the model returned one, and keeps unmarked odometerKm", () => {
    expect(
      postFilterFilled(
        { make: "FIAT", odometerKm: 12000 },
        { make: "VW" },
        ["make"],
      ),
    ).toEqual({ odometerKm: 12000 });
  });

  it("keeps extracted keys when the stored value is undefined", () => {
    expect(postFilterFilled({ plate: "ABC1D23" }, { plate: undefined })).toEqual({
      plate: "ABC1D23",
    });
  });
});
