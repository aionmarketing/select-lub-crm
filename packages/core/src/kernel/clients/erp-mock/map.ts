/**
 * Bidirectional mapping between CRM shared fields and Omie client wire snapshots.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import {
  BRAZIL_CODIGO_PAIS,
  CARACTERISTICA_CAMPOS,
  CONTEUDO_MAX,
  isVehicleField,
} from "./fields.js";

/** One Omie custom characteristic row (`campo` + `conteudo`) on a client. */
export type OmieCaracteristica = { campo: string; conteudo: string };

/** Parsed Omie client fields as returned by consult/list calls before CRM column mapping. */
export type OmieClientSnapshot = {
  razao_social: string | null;
  cnpj_cpf: string | null;
  telefone: string | null;
  email: string | null;
  endereco: string | null;
  endereco_numero: string | null;
  bairro: string | null;
  complemento: string | null;
  cidade: string | null;
  estado: string | null;
  cep: string | null;
  codigo_pais: string | null;
  caracteristicas: OmieCaracteristica[];
};

/** CRM-side value for a shared field before wire encoding. */
export type CrmFieldValue = string | number | null;

/**
 * Returns an empty Omie client snapshot with all scalar fields `null` and no características.
 *
 * @returns Fresh snapshot safe to mutate before a put or fake seed.
 */
export function emptySnapshot(): OmieClientSnapshot {
  return {
    razao_social: null,
    cnpj_cpf: null,
    telefone: null,
    email: null,
    endereco: null,
    endereco_numero: null,
    bairro: null,
    complemento: null,
    cidade: null,
    estado: null,
    cep: null,
    codigo_pais: null,
    caracteristicas: [],
  };
}

/**
 * Converts a CRM field value to its string form for pending rows and comparisons.
 *
 * @param value - CRM column value; `null` becomes `""`.
 * @returns Decimal string for numbers, empty string for `null`, otherwise `String(value)`.
 */
export function stringifyCrmValue(value: CrmFieldValue): string {
  if (value === null) {
    return "";
  }
  return String(value);
}

/**
 * Encodes a CRM country code for Omie `codigo_pais` wire.
 *
 * @param country - CRM country code (`br` maps to Brazil); `null` or `""` encode as empty wire.
 * @returns Omie wire value (`1058` for Brazil) or the original code when not `br`.
 */
export function countryToWire(country: string | null): string {
  if (country === null || country === "") {
    return "";
  }
  if (country === "br") {
    return BRAZIL_CODIGO_PAIS;
  }
  return country;
}

/**
 * Decodes an Omie `codigo_pais` wire value into a CRM country code.
 *
 * @param codigoPais - Omie country code from a snapshot; `null` or `""` decode to `null`.
 * @returns `"br"` for Brazil (`1058`), otherwise the wire value unchanged, or `null` when empty.
 */
export function countryFromWire(codigoPais: string | null): string | null {
  if (codigoPais === null || codigoPais === "") {
    return null;
  }
  if (codigoPais === BRAZIL_CODIGO_PAIS) {
    return "br";
  }
  return codigoPais;
}

/**
 * Encodes one shared CRM field for Omie wire.
 *
 * @param fieldKey - Shared field to encode.
 * @param value - CRM value for that field; `null` encodes as empty wire except where field-specific rules apply.
 * @returns `{ ok: true, wire }` with the Omie string, or `{ ok: false }` when a vehicle característica exceeds `CONTEUDO_MAX`.
 */
export function toWire(
  fieldKey: OmieSharedFieldKey,
  value: CrmFieldValue,
): { ok: true; wire: string } | { ok: false } {
  let wire: string;
  if (fieldKey === "country") {
    wire = countryToWire(typeof value === "string" || value === null ? value : String(value));
  } else if (fieldKey === "odometerKm") {
    wire = value === null ? "" : String(value);
  } else {
    wire = stringifyCrmValue(value);
  }
  if (isVehicleField(fieldKey) && wire.length > CONTEUDO_MAX) {
    return { ok: false };
  }
  return { ok: true, wire };
}

/**
 * Reads one shared field from an Omie snapshot.
 *
 * @param snapshot - Parsed Omie client row.
 * @param fieldKey - Shared field to read.
 * @returns `{ status: "value", crm, wire }` with CRM and wire forms, or `{ status: "skip" }` when odometer wire is non-numeric.
 */
export function readSnapshotField(
  snapshot: OmieClientSnapshot,
  fieldKey: OmieSharedFieldKey,
): { status: "value"; crm: CrmFieldValue; wire: string } | { status: "skip" } {
  switch (fieldKey) {
    case "name":
      return valueResult(snapshot.razao_social, snapshot.razao_social ?? "");
    case "taxId":
      return valueResult(snapshot.cnpj_cpf, snapshot.cnpj_cpf ?? "");
    case "primaryPhone":
      return valueResult(snapshot.telefone, snapshot.telefone ?? "");
    case "primaryEmail":
      return valueResult(snapshot.email, snapshot.email ?? "");
    case "street":
      return valueResult(snapshot.endereco, snapshot.endereco ?? "");
    case "streetNumber":
      return valueResult(snapshot.endereco_numero, snapshot.endereco_numero ?? "");
    case "neighborhood":
      return valueResult(snapshot.bairro, snapshot.bairro ?? "");
    case "complement":
      return valueResult(snapshot.complemento, snapshot.complemento ?? "");
    case "city":
      return valueResult(snapshot.cidade, snapshot.cidade ?? "");
    case "state":
      return valueResult(snapshot.estado, snapshot.estado ?? "");
    case "postalCode":
      return valueResult(snapshot.cep, snapshot.cep ?? "");
    case "country": {
      const wire = snapshot.codigo_pais ?? "";
      return { status: "value", crm: countryFromWire(snapshot.codigo_pais), wire };
    }
    case "plate":
      return valueResult(
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.plate),
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.plate) ?? "",
      );
    case "make":
      return valueResult(
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.make),
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.make) ?? "",
      );
    case "model":
      return valueResult(
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.model),
        caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.model) ?? "",
      );
    case "odometerKm": {
      const conteudo = caracteristicaConteudo(snapshot, CARACTERISTICA_CAMPOS.odometerKm);
      const wire = conteudo ?? "";
      if (conteudo === null || conteudo === "") {
        return { status: "value", crm: null, wire };
      }
      const parsed = Number(conteudo);
      if (!Number.isFinite(parsed)) {
        return { status: "skip" };
      }
      return { status: "value", crm: parsed, wire };
    }
  }
}

function valueResult(
  crm: string | null,
  wire: string,
): { status: "value"; crm: CrmFieldValue; wire: string } {
  return { status: "value", crm, wire };
}

/**
 * Writes one encoded wire value into an in-memory Omie snapshot (mutates `snapshot`).
 *
 * @param snapshot - Target snapshot to update in place.
 * @param fieldKey - Shared field being written.
 * @param wire - Omie wire string; empty string clears scalar fields or upserts an empty característica.
 * @returns `void`; vehicle fields upsert `caracteristicas` by `campo` label.
 */
export function applyWireToSnapshot(
  snapshot: OmieClientSnapshot,
  fieldKey: OmieSharedFieldKey,
  wire: string,
): void {
  switch (fieldKey) {
    case "name":
      snapshot.razao_social = wire === "" ? null : wire;
      return;
    case "taxId":
      snapshot.cnpj_cpf = wire === "" ? null : wire;
      return;
    case "primaryPhone":
      snapshot.telefone = wire === "" ? null : wire;
      return;
    case "primaryEmail":
      snapshot.email = wire === "" ? null : wire;
      return;
    case "street":
      snapshot.endereco = wire === "" ? null : wire;
      return;
    case "streetNumber":
      snapshot.endereco_numero = wire === "" ? null : wire;
      return;
    case "neighborhood":
      snapshot.bairro = wire === "" ? null : wire;
      return;
    case "complement":
      snapshot.complemento = wire === "" ? null : wire;
      return;
    case "city":
      snapshot.cidade = wire === "" ? null : wire;
      return;
    case "state":
      snapshot.estado = wire === "" ? null : wire;
      return;
    case "postalCode":
      snapshot.cep = wire === "" ? null : wire;
      return;
    case "country":
      snapshot.codigo_pais = wire === "" ? null : wire;
      return;
    case "plate":
    case "make":
    case "model":
    case "odometerKm":
      upsertCaracteristica(snapshot, CARACTERISTICA_CAMPOS[fieldKey], wire);
      return;
  }
}

function caracteristicaConteudo(
  snapshot: OmieClientSnapshot,
  campo: string,
): string | null {
  const row = snapshot.caracteristicas.find((item) => item.campo === campo);
  return row ? row.conteudo : null;
}

function upsertCaracteristica(snapshot: OmieClientSnapshot, campo: string, conteudo: string): void {
  const existing = snapshot.caracteristicas.find((item) => item.campo === campo);
  if (existing) {
    existing.conteudo = conteudo;
    return;
  }
  snapshot.caracteristicas.push({ campo, conteudo });
}
