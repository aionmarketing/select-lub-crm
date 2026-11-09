/**
 * Test design (testing-strategy)
 *
 * Setup: pure map.ts encode/decode. No HTTP, no store.
 *
 * Oracle: omie-sync — country `br` ↔ `1058`, other ISO-2 pass through;
 * empty/`null` wire ↔ null CRM; `conteudo` > 60 fails without truncate;
 * unparseable KM skips; person fields map to native Omie columns;
 * vehicle fields map to características Placa/Marca/Modelo/KM.
 *
 * Axes
 *   A1 country — null / "" / br / other
 *   A2 odometer — null / number / empty wire / non-numeric / numeric
 *   A3 vehicle length — 60 / 61
 *   A4 scalar write — empty clears / non-empty sets
 *   A5 característica — missing / insert / overwrite
 *
 * Outputs
 *   O1 wire string; O2 CRM value; O3 skip; O4 fail; O5 mutated snapshot
 *
 * Sampled-cell
 *   stringify null / number     | A2 | O1 | "null"
 *   country br / us / empty     | A1 | O1/O2 | 1058 rewritten
 *   toWire plate 61             | A3 | O4 | truncated 60
 *   KM non-numeric              | A2 | O3 | parsed NaN stored
 *   apply empty name            | A4 | O5 | "" stored
 *   upsert existing KM          | A5 | O5 | second row
 *
 * Decision map (map.ts)
 *   stringifyCrmValue null T: stringify it; F: number/string
 *   countryToWire empty T: null/""; F: br / us
 *   country === "br" T: br; F: us
 *   countryFromWire empty T: null/""; F: 1058 / us
 *   codigo === BRAZIL T: 1058; F: us
 *   toWire country / odometer / other — each sampled
 *   vehicle && length>60 T: plate 61; F: plate 60
 *   readSnapshotField switch — every SHARED_FIELD_KEY
 *   odometer empty T: null CRM; F: numeric / skip
 *   !Number.isFinite T: skip; F: numeric
 *   applyWire empty T: scalars null; F: set value
 *   caracteristica find T: overwrite; F: insert
 *
 * Out of scope: engine decideField; live Omie HTTP.
 */
import { describe, expect, it } from "vitest";
import { BRAZIL_CODIGO_PAIS, CARACTERISTICA_CAMPOS, CONTEUDO_MAX, SHARED_FIELD_KEYS } from "./fields.js";
import {
  applyWireToSnapshot,
  countryFromWire,
  countryToWire,
  emptySnapshot,
  readSnapshotField,
  stringifyCrmValue,
  toWire,
} from "./map.js";

describe("stringifyCrmValue", () => {
  it("turns null into an empty wire string", () => {
    expect(stringifyCrmValue(null)).toBe("");
  });

  it("stringifies a number without inventing units", () => {
    expect(stringifyCrmValue(12000)).toBe("12000");
  });
});

describe("country wire", () => {
  it.each([
    { label: "null", value: null, wire: "" },
    { label: "empty", value: "", wire: "" },
    { label: "br", value: "br", wire: BRAZIL_CODIGO_PAIS },
    { label: "us", value: "us", wire: "us" },
  ])("encodes $label to $wire", ({ value, wire }) => {
    expect(countryToWire(value)).toBe(wire);
  });

  it.each([
    { label: "null", wire: null, crm: null },
    { label: "empty", wire: "", crm: null },
    { label: "Brazil", wire: BRAZIL_CODIGO_PAIS, crm: "br" },
    { label: "us", wire: "us", crm: "us" },
  ])("decodes $label to $crm", ({ wire, crm }) => {
    expect(countryFromWire(wire)).toBe(crm);
  });
});

describe("toWire", () => {
  it("encodes country from a non-string CRM value", () => {
    expect(toWire("country", 1058)).toEqual({ ok: true, wire: "1058" });
  });

  it("encodes a null odometer as empty wire", () => {
    expect(toWire("odometerKm", null)).toEqual({ ok: true, wire: "" });
  });

  it("rejects a vehicle característica longer than 60 without truncating", () => {
    const plate = "p".repeat(CONTEUDO_MAX + 1);
    expect(toWire("plate", plate)).toEqual({ ok: false });
    expect(plate).toHaveLength(61);
  });

  it("accepts a 60-character plate", () => {
    const plate = "p".repeat(CONTEUDO_MAX);
    expect(toWire("plate", plate)).toEqual({ ok: true, wire: plate });
  });
});

describe("readSnapshotField", () => {
  it("reads every shared field from a populated snapshot", () => {
    const snapshot = emptySnapshot();
    snapshot.razao_social = "Ana";
    snapshot.cnpj_cpf = "39053344705";
    snapshot.telefone = "11999990000";
    snapshot.email = "ana@example.com";
    snapshot.endereco = "Rua A";
    snapshot.endereco_numero = "10";
    snapshot.bairro = "Centro";
    snapshot.complemento = "ap 1";
    snapshot.cidade = "Sao Paulo";
    snapshot.estado = "SP";
    snapshot.cep = "01310100";
    snapshot.codigo_pais = BRAZIL_CODIGO_PAIS;
    snapshot.caracteristicas = [
      { campo: CARACTERISTICA_CAMPOS.plate, conteudo: "ABC1D23" },
      { campo: CARACTERISTICA_CAMPOS.make, conteudo: "VW" },
      { campo: CARACTERISTICA_CAMPOS.model, conteudo: "Gol" },
      { campo: CARACTERISTICA_CAMPOS.odometerKm, conteudo: "12000" },
    ];

    expect(SHARED_FIELD_KEYS.map((key) => [key, readSnapshotField(snapshot, key)])).toEqual([
      ["name", { status: "value", crm: "Ana", wire: "Ana" }],
      ["taxId", { status: "value", crm: "39053344705", wire: "39053344705" }],
      ["primaryPhone", { status: "value", crm: "11999990000", wire: "11999990000" }],
      ["primaryEmail", { status: "value", crm: "ana@example.com", wire: "ana@example.com" }],
      ["street", { status: "value", crm: "Rua A", wire: "Rua A" }],
      ["streetNumber", { status: "value", crm: "10", wire: "10" }],
      ["neighborhood", { status: "value", crm: "Centro", wire: "Centro" }],
      ["complement", { status: "value", crm: "ap 1", wire: "ap 1" }],
      ["city", { status: "value", crm: "Sao Paulo", wire: "Sao Paulo" }],
      ["state", { status: "value", crm: "SP", wire: "SP" }],
      ["postalCode", { status: "value", crm: "01310100", wire: "01310100" }],
      ["country", { status: "value", crm: "br", wire: BRAZIL_CODIGO_PAIS }],
      ["plate", { status: "value", crm: "ABC1D23", wire: "ABC1D23" }],
      ["make", { status: "value", crm: "VW", wire: "VW" }],
      ["model", { status: "value", crm: "Gol", wire: "Gol" }],
      ["odometerKm", { status: "value", crm: 12000, wire: "12000" }],
    ]);
  });

  it("reads missing scalars as empty wire and missing KM as null", () => {
    const snapshot = emptySnapshot();

    expect(readSnapshotField(snapshot, "name")).toEqual({ status: "value", crm: null, wire: "" });
    expect(readSnapshotField(snapshot, "country")).toEqual({ status: "value", crm: null, wire: "" });
    expect(readSnapshotField(snapshot, "plate")).toEqual({ status: "value", crm: null, wire: "" });
    expect(readSnapshotField(snapshot, "odometerKm")).toEqual({ status: "value", crm: null, wire: "" });
  });

  it("skips an unparseable KM without inventing a number", () => {
    const snapshot = emptySnapshot();
    snapshot.caracteristicas = [{ campo: CARACTERISTICA_CAMPOS.odometerKm, conteudo: "nao-e-numero" }];

    expect(readSnapshotField(snapshot, "odometerKm")).toEqual({ status: "skip" });
  });
});

describe("applyWireToSnapshot", () => {
  it("clears every scalar on empty wire and upserts vehicle características", () => {
    const snapshot = emptySnapshot();
    snapshot.razao_social = "Ana";
    snapshot.caracteristicas = [{ campo: CARACTERISTICA_CAMPOS.plate, conteudo: "OLD" }];

    applyWireToSnapshot(snapshot, "name", "");
    applyWireToSnapshot(snapshot, "taxId", "");
    applyWireToSnapshot(snapshot, "primaryPhone", "");
    applyWireToSnapshot(snapshot, "primaryEmail", "");
    applyWireToSnapshot(snapshot, "street", "");
    applyWireToSnapshot(snapshot, "streetNumber", "");
    applyWireToSnapshot(snapshot, "neighborhood", "");
    applyWireToSnapshot(snapshot, "complement", "");
    applyWireToSnapshot(snapshot, "city", "");
    applyWireToSnapshot(snapshot, "state", "");
    applyWireToSnapshot(snapshot, "postalCode", "");
    applyWireToSnapshot(snapshot, "country", "");
    applyWireToSnapshot(snapshot, "plate", "ABC1D23");
    applyWireToSnapshot(snapshot, "make", "VW");
    applyWireToSnapshot(snapshot, "model", "Gol");
    applyWireToSnapshot(snapshot, "odometerKm", "8000");
    applyWireToSnapshot(snapshot, "odometerKm", "9000");

    expect(snapshot.razao_social).toBeNull();
    expect(snapshot.cnpj_cpf).toBeNull();
    expect(snapshot.telefone).toBeNull();
    expect(snapshot.email).toBeNull();
    expect(snapshot.endereco).toBeNull();
    expect(snapshot.endereco_numero).toBeNull();
    expect(snapshot.bairro).toBeNull();
    expect(snapshot.complemento).toBeNull();
    expect(snapshot.cidade).toBeNull();
    expect(snapshot.estado).toBeNull();
    expect(snapshot.cep).toBeNull();
    expect(snapshot.codigo_pais).toBeNull();
    expect(snapshot.caracteristicas).toEqual([
      { campo: CARACTERISTICA_CAMPOS.plate, conteudo: "ABC1D23" },
      { campo: CARACTERISTICA_CAMPOS.make, conteudo: "VW" },
      { campo: CARACTERISTICA_CAMPOS.model, conteudo: "Gol" },
      { campo: CARACTERISTICA_CAMPOS.odometerKm, conteudo: "9000" },
    ]);
  });

  it("writes non-empty scalars including country", () => {
    const snapshot = emptySnapshot();
    applyWireToSnapshot(snapshot, "name", "Ana");
    applyWireToSnapshot(snapshot, "taxId", "39053344705");
    applyWireToSnapshot(snapshot, "primaryPhone", "11999990000");
    applyWireToSnapshot(snapshot, "primaryEmail", "ana@example.com");
    applyWireToSnapshot(snapshot, "street", "Rua A");
    applyWireToSnapshot(snapshot, "streetNumber", "10");
    applyWireToSnapshot(snapshot, "neighborhood", "Centro");
    applyWireToSnapshot(snapshot, "complement", "ap 1");
    applyWireToSnapshot(snapshot, "city", "Sao Paulo");
    applyWireToSnapshot(snapshot, "state", "SP");
    applyWireToSnapshot(snapshot, "postalCode", "01310100");
    applyWireToSnapshot(snapshot, "country", BRAZIL_CODIGO_PAIS);

    expect(snapshot.razao_social).toBe("Ana");
    expect(snapshot.cnpj_cpf).toBe("39053344705");
    expect(snapshot.telefone).toBe("11999990000");
    expect(snapshot.email).toBe("ana@example.com");
    expect(snapshot.endereco).toBe("Rua A");
    expect(snapshot.endereco_numero).toBe("10");
    expect(snapshot.bairro).toBe("Centro");
    expect(snapshot.complemento).toBe("ap 1");
    expect(snapshot.cidade).toBe("Sao Paulo");
    expect(snapshot.estado).toBe("SP");
    expect(snapshot.cep).toBe("01310100");
    expect(snapshot.codigo_pais).toBe(BRAZIL_CODIGO_PAIS);
  });
});
