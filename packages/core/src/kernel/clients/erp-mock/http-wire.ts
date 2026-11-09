/**
 * The HTTP Omie adapter's wire helpers: read a response body and its
 * `Retry-After`, map an Omie `ClienteCadastro` to a listed client, and build the
 * `param` for `AlterarCliente` / `IncluirCliente`.
 *
 * Moved verbatim from `http.ts` in wave 5.1b, when core's 300-line rule met the
 * file; the adapter itself stays whole in `http.ts`.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { OmieListedClient } from "./adapter.js";
import type { OmieCaracteristica, OmieClientSnapshot } from "./map.js";
import { digitsOnly } from "./sanitize.js";

export async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return seconds * 1000;
}

export function mapCliente(raw: Record<string, unknown>): OmieListedClient {
  const ddd = String(raw.telefone1_ddd ?? "");
  const number = String(raw.telefone1_numero ?? raw.telefone ?? "");
  const joined = `${digitsOnly(ddd)}${digitsOnly(number)}`;
  const caracteristicas = readCaracteristicas(raw.caracteristicas);
  const snapshot: OmieClientSnapshot = {
    razao_social: stringOrNull(raw.razao_social),
    cnpj_cpf: stringOrNull(raw.cnpj_cpf),
    telefone: joined === "" ? null : joined,
    email: stringOrNull(raw.email),
    endereco: stringOrNull(raw.endereco),
    endereco_numero: stringOrNull(raw.endereco_numero),
    bairro: stringOrNull(raw.bairro),
    complemento: stringOrNull(raw.complemento),
    cidade: stringOrNull(raw.cidade),
    estado: stringOrNull(raw.estado),
    cep: stringOrNull(raw.cep),
    codigo_pais: stringOrNull(raw.codigo_pais),
    caracteristicas,
  };
  return {
    omieId: String(raw.codigo_cliente_omie ?? ""),
    snapshot,
    codigoIntegracao: raw.codigo_cliente_integracao
      ? String(raw.codigo_cliente_integracao)
      : undefined,
  };
}

function readCaracteristicas(value: unknown): OmieCaracteristica[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { caracteristica?: unknown }).caracteristica)
      ? (value as { caracteristica: unknown[] }).caracteristica
      : [];
  const mapped: OmieCaracteristica[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      const campo = (row as { campo?: unknown }).campo;
      const conteudo = (row as { conteudo?: unknown }).conteudo;
      if (typeof campo === "string" && typeof conteudo === "string") {
        mapped.push({ campo, conteudo });
      }
    }
  }
  return mapped;
}

export function writtenFieldsToOmieParam(
  snapshot: OmieClientSnapshot,
  written: readonly OmieSharedFieldKey[],
): Record<string, unknown> {
  const param: Record<string, unknown> = {};
  for (const key of written) {
    switch (key) {
      case "name":
        param.razao_social = snapshot.razao_social ?? "";
        break;
      case "taxId":
        param.cnpj_cpf = snapshot.cnpj_cpf ?? "";
        break;
      case "primaryPhone":
        param.telefone1_numero = snapshot.telefone ?? "";
        break;
      case "primaryEmail":
        param.email = snapshot.email ?? "";
        break;
      case "street":
        param.endereco = snapshot.endereco ?? "";
        break;
      case "streetNumber":
        param.endereco_numero = snapshot.endereco_numero ?? "";
        break;
      case "neighborhood":
        param.bairro = snapshot.bairro ?? "";
        break;
      case "complement":
        param.complemento = snapshot.complemento ?? "";
        break;
      case "city":
        param.cidade = snapshot.cidade ?? "";
        break;
      case "state":
        param.estado = snapshot.estado ?? "";
        break;
      case "postalCode":
        param.cep = snapshot.cep ?? "";
        break;
      case "country":
        param.codigo_pais = snapshot.codigo_pais ?? "";
        break;
      case "plate":
      case "make":
      case "model":
      case "odometerKm":
        param.caracteristicas = snapshot.caracteristicas;
        break;
    }
  }
  return param;
}

export function snapshotToOmieParam(snapshot: OmieClientSnapshot): Record<string, unknown> {
  return {
    razao_social: snapshot.razao_social ?? "",
    cnpj_cpf: snapshot.cnpj_cpf ?? "",
    email: snapshot.email ?? "",
    telefone1_numero: snapshot.telefone ?? "",
    endereco: snapshot.endereco ?? "",
    endereco_numero: snapshot.endereco_numero ?? "",
    bairro: snapshot.bairro ?? "",
    complemento: snapshot.complemento ?? "",
    cidade: snapshot.cidade ?? "",
    estado: snapshot.estado ?? "",
    cep: snapshot.cep ?? "",
    codigo_pais: snapshot.codigo_pais ?? "",
    caracteristicas: snapshot.caracteristicas,
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  return value;
}
