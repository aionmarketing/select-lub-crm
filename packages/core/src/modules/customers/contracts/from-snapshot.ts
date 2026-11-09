/**
 * Builds CRM customer column values from a parsed Omie client snapshot.
 */
import { randomUUID } from "node:crypto";
import { countryFromWire } from "../../../kernel/clients/erp-mock.js";
import type { OmieClientSnapshot } from "../../../kernel/clients/erp-mock.js";
import { digitsOnly } from "../../../kernel/clients/erp-mock.js";
import type { CustomerRecord } from "./cadastro-store/port.js";

/**
 * Maps Omie `razao_social` to a CRM name. Empty/whitespace becomes `null`, never `"Omie"`.
 *
 * @param razaoSocial - Wire razão social from consult, list, or pull.
 * @returns Trimmed name, or `null` when missing/blank.
 */
export function nameFromRazaoSocial(razaoSocial: string | null | undefined): string | null {
  const trimmed = razaoSocial?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Keeps a stored CRM name when a later Omie snapshot has no razão social.
 *
 * @param existingName - Current CRM `Customer.name`.
 * @param incomingName - Mapped snapshot name (`null` when Omie is empty).
 * @returns Existing non-empty name when incoming is null; otherwise incoming.
 */
export function retainStoredName(
  existingName: string | null | undefined,
  incomingName: string | null,
): string | null {
  if (incomingName == null && existingName != null && existingName.trim() !== "") {
    return existingName;
  }
  return incomingName;
}

/**
 * Maps Omie snapshot person fields into customer columns and primary contact arrays.
 *
 * @param snapshot - Parsed Omie client row from consult, list, or consult.
 * @returns Customer column subset; `name` is null when `razao_social` is empty; phones and emails arrays are empty when wire values are missing.
 */
export function customerFieldsFromSnapshot(
  snapshot: OmieClientSnapshot,
): Pick<
  CustomerRecord,
  | "name"
  | "taxId"
  | "street"
  | "streetNumber"
  | "neighborhood"
  | "complement"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "phones"
  | "emails"
> {
  const phoneDigits = digitsOnly(snapshot.telefone);
  return {
    name: nameFromRazaoSocial(snapshot.razao_social),
    taxId: snapshot.cnpj_cpf,
    street: snapshot.endereco,
    streetNumber: snapshot.endereco_numero,
    neighborhood: snapshot.bairro,
    complement: snapshot.complemento,
    city: snapshot.cidade,
    state: snapshot.estado,
    postalCode: snapshot.cep,
    country: countryFromWire(snapshot.codigo_pais),
    phones:
      phoneDigits === ""
        ? []
        : [{ raw: snapshot.telefone ?? phoneDigits, normalized: phoneDigits, isPrimary: true }],
    emails:
      snapshot.email && snapshot.email !== ""
        ? [{ raw: snapshot.email, normalized: snapshot.email.toLowerCase(), isPrimary: true }]
        : [],
  };
}

/**
 * Creates a new CRM customer row seeded from an Omie id and snapshot.
 *
 * @param omieId - Linked Omie `codigo_cliente_omie`; must not be empty.
 * @param snapshot - Omie wire snapshot used to populate shared person fields.
 * @returns New `CustomerRecord` with a random CRM id, `origin: "OMIE_SYNC"`, `unitId: null`, and ISO timestamps.
 */
export function newCustomerFromSnapshot(omieId: string, snapshot: OmieClientSnapshot): CustomerRecord {
  const stamp = new Date().toISOString();
  return {
    id: randomUUID(),
    omieId,
    unitId: null,
    givenName: null,
    familyName: null,
    mergedIntoId: null,
    origin: "OMIE_SYNC",
    status: "active",
    createdAt: stamp,
    updatedAt: stamp,
    ...customerFieldsFromSnapshot(snapshot),
  };
}
