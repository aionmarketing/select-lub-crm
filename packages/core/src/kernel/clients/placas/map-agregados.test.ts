/**
 * Test design (testing-strategy)
 *
 * Setup: the two exported functions called directly, no HTTP. map-agregados.ts
 * had no test file of its own — it was reached only through
 * agregados-propria.test.ts, which drives it with two whole fixtures and so
 * samples each decision from one side only.
 *
 * Oracle, strongest first:
 *   - openspec/specs/plate-lookup/plate-lookup/spec.md:118-121, "Billed calls are recorded in
 *     a ledger of their own" — every call consuming credit is recorded so spend
 *     reconciles against a prepaid balance; a call a provider refused without
 *     billing writes no entry. Governs every apibrasilConsumedCredit row.
 *   - openspec/specs/plate-lookup/plate-lookup/spec.md:39, "Unknown fields are omitted, never
 *     invented" — a lookup yielding no usable field reports not-found carrying
 *     no values. Governs the mapAgregadosPropriaData rows.
 *   - Module contract at map-agregados.ts:59-61 and record.ts:9, NOT an OpenSpec
 *     scenario — the weaker oracle, recorded deliberately. The spec fixes WHICH
 *     calls bill but not how the envelope encodes it, so the homolog / error /
 *     valor_consulta encoding comes from the docstring. Checked against the code
 *     before use: the doc's four claims (non-200, homolog, error, >0 bills, and
 *     omitted-is-billed) each match a branch, in that order. Where the doc is
 *     SILENT rather than wrong — a valor_consulta present but not numeric — no
 *     value is asserted; see the skipped row.
 *
 * Axes
 * A1 httpStatus — 200 / 402 / 404 / 500
 * A2 envelope shape — object / null / non-object / array
 * A3 homolog+error flags — homolog true / error true / both false
 * A4 valor_consulta — >0 / exactly 0 / absent / non-number
 * A5 data node — object / undefined / null / primitive / array
 *
 * Outputs: O-billed true; O-billed false; O-empty field set
 *
 * Decision map (map-agregados.ts)
 * D1 httpStatus !== 200            T: 402/404/500 rows; F: every 200 row
 * D2 !row || homolog || error      T: null/array/homolog/error rows; F: live rows
 * D3 typeof valor_consulta number  T: 0.08 and 0 rows; F: absent and string rows
 * D4 valor_consulta > 0            T: 0.08 row; F: exactly-0 row
 * D5 !row in mapAgregadosPropriaData  T: A5 non-object rows; F: fields row
 *
 * D3-false and D4-false are the two this file exists for. Before it, the live
 * fixture (valor_consulta 0.08, homolog false) drove D3 true and D4 true, and
 * the sandbox fixture short-circuited at D2 on homolog, so neither the
 * omitted-field safety default nor a genuine zero charge had a reaching input.
 *
 * Boundaries: valor_consulta at exactly 0 and at 0.08 — the edge of "greater
 * than 0 bills". Below-zero is not sampled: a negative charge is not a state the
 * gateway produces and the spec does not contemplate one.
 *
 * Left untested, with reasons:
 *   - valor_consulta present but not a number: SKIPPED, not omitted. The
 *     docstring covers only the field being absent, so there is no oracle for a
 *     string or null, and the current behaviour over-reports spend for a string
 *     "0". Raised for the owner rather than pinned. Branch coverage is
 *     unaffected — the omitted-field row already executes that arm.
 *   - The field-mapping preference chain (sintetico string vs boolean vs modelo)
 *     and placeholder rejection: out of scope, already sampled against real
 *     captures in agregados-propria.test.ts. Duplicating them here would add
 *     rows without adding a decision.
 *   - No decision in this module is left one-sided by this file.
 */
import { describe, expect, it } from "vitest";
import { apibrasilConsumedCredit, mapAgregadosPropriaData } from "./map-agregados.js";

describe("apibrasilConsumedCredit", () => {
  it.each([
    { label: "402 exhausted balance", status: 402 },
    { label: "404 unregistered plate", status: 404 },
    { label: "500 gateway failure", status: 500 },
  ])("does not bill on $label", ({ status }) => {
    expect(apibrasilConsumedCredit(status, { valor_consulta: 0.08 })).toBe(false);
  });

  it.each([
    { label: "a homolog envelope", body: { homolog: true, valor_consulta: 0.08 } },
    { label: "an error envelope", body: { error: true, valor_consulta: 0.08 } },
    { label: "a null body", body: null },
    { label: "a non-object body", body: "gateway timeout" },
    { label: "an array body", body: [{ valor_consulta: 0.08 }] },
  ])("does not bill on a 200 carrying $label", ({ body }) => {
    expect(apibrasilConsumedCredit(200, body)).toBe(false);
  });

  it("bills a live 200 that charged for the query", () => {
    expect(
      apibrasilConsumedCredit(200, { homolog: false, error: false, valor_consulta: 0.08 }),
    ).toBe(true);
  });

  // Boundary on the charge. Before this row `valor_consulta > 0` only ever
  // evaluated true: the live fixture charges 0.08, and the one fixture carrying
  // a zero also carries homolog:true, so it returns false an instruction earlier
  // and never reaches the comparison. A live zero-rated call must not be billed.
  it("does not bill a live 200 that charged exactly zero", () => {
    expect(
      apibrasilConsumedCredit(200, { homolog: false, error: false, valor_consulta: 0 }),
    ).toBe(false);
  });

  // The documented safety default, map-agregados.ts:61 — "a live 200 that omits
  // that field is treated as billed so a missing zero cannot hide a debit." No
  // fixture omits the field, so this `return true` never executed. Flipped to
  // `false`, real spend would stop reaching the ledger and the prepaid balance
  // would stop reconciling, with nothing failing to say so.
  it("bills a live 200 that omits valor_consulta, so a missing charge cannot hide a debit", () => {
    expect(apibrasilConsumedCredit(200, { homolog: false, error: false })).toBe(true);
  });
});

describe("mapAgregadosPropriaData", () => {
  // Reachable in production: the 404 arm of the adapter calls this with
  // `envelope?.data`, which is undefined whenever the body is missing, not JSON,
  // or carries no data node.
  it.each([
    { label: "undefined", data: undefined },
    { label: "null", data: null },
    { label: "a string", data: "no data" },
    { label: "a number", data: 0 },
    { label: "an array", data: [{ marca: "VW" }] },
  ])("returns an empty field set when data is $label", ({ data }) => {
    expect(mapAgregadosPropriaData(data)).toEqual({});
  });

  it("keeps only the keys the provider actually supplied", () => {
    const fields = mapAgregadosPropriaData({ marca: "VW", modelo: "GOL" });

    expect(fields).toEqual({ make: "VW", model: "GOL" });
    expect(fields).not.toHaveProperty("version");
    expect(fields).not.toHaveProperty("year");
  });
});

describe("a reported charge is read whether it is a number or a numeric string", () => {
  // Ruling 3e. `valor_consulta` arriving as `"0"` used to fall into the
  // absent-field branch and bill, because the check was `typeof === "number"`.
  // The ledger exists to reconcile spend against a prepaid balance
  // (`plate-lookup/spec.md:119`, "Every provider call that consumes credit"), so
  // a call that consumed nothing must not appear in it.
  it.each([
    { name: "numeric zero", valor: 0, billed: false },
    { name: "string zero", valor: "0", billed: false },
    { name: "string zero with decimals", valor: "0.00", billed: false },
    { name: "numeric charge", valor: 1.2, billed: true },
    { name: "string charge", valor: "1.20", billed: true },
  ])("$name bills: $billed", ({ valor, billed }) => {
    expect(apibrasilConsumedCredit(200, { valor_consulta: valor })).toBe(billed);
  });

  // The conservative fallback is deliberate and must survive: when the charge
  // cannot be read at all, bill it, so a missing zero cannot hide a real debit.
  // Only a value that is present AND readable is believed.
  it.each([
    { name: "field absent", body: {} },
    { name: "unparseable string", body: { valor_consulta: "grátis" } },
    { name: "empty string", body: { valor_consulta: "" } },
    { name: "null", body: { valor_consulta: null } },
    { name: "NaN", body: { valor_consulta: Number.NaN } },
  ])("$name still bills, so an unreadable charge cannot hide a debit", ({ body }) => {
    expect(apibrasilConsumedCredit(200, body)).toBe(true);
  });
});
