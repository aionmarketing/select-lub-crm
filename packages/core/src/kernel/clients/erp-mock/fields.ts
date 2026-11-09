/**
 * Shared field key catalogs and Omie wire limits for the cadastro sync contract.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";

/** Person-level shared fields stored on the customer row and synced with Omie. */
export const PERSON_FIELD_KEYS = [
  "name",
  "taxId",
  "primaryPhone",
  "primaryEmail",
  "street",
  "streetNumber",
  "neighborhood",
  "complement",
  "city",
  "state",
  "postalCode",
  "country",
] as const satisfies readonly OmieSharedFieldKey[];

/** Vehicle shared fields stored on the titular vehicle and synced via Omie características. */
export const VEHICLE_FIELD_KEYS = [
  "plate",
  "make",
  "model",
  "odometerKm",
] as const satisfies readonly OmieSharedFieldKey[];

/** All Omie-shared field keys across person and titular vehicle columns. */
export const SHARED_FIELD_KEYS = [
  ...PERSON_FIELD_KEYS,
  ...VEHICLE_FIELD_KEYS,
] as const satisfies readonly OmieSharedFieldKey[];

/** CRM-only customer fields that never cross the Omie wire. */
export const CRM_ONLY_KEYS = ["givenName", "familyName", "mergedInto"] as const;

/** Omie característica `campo` labels for each vehicle shared field. */
export const CARACTERISTICA_CAMPOS = {
  plate: "Placa",
  make: "Marca",
  model: "Modelo",
  odometerKm: "KM",
} as const;

/** Omie `codigo_pais` wire value for Brazil. */
export const BRAZIL_CODIGO_PAIS = "1058";

/** Maximum length Omie accepts for característica `conteudo` values. */
export const CONTEUDO_MAX = 60;

/**
 * Returns whether a shared field key is stored on the titular vehicle row.
 *
 * @param key - Any `OmieSharedFieldKey` from the sync contract.
 * @returns `true` for `plate`, `make`, `model`, and `odometerKm`.
 */
export function isVehicleField(key: OmieSharedFieldKey): key is (typeof VEHICLE_FIELD_KEYS)[number] {
  return (VEHICLE_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Narrows an arbitrary string to a known shared field key.
 *
 * @param key - Candidate field name from external input.
 * @returns `true` when `key` is one of `SHARED_FIELD_KEYS`.
 */
export function isSharedFieldKey(key: string): key is OmieSharedFieldKey {
  return (SHARED_FIELD_KEYS as readonly string[]).includes(key);
}
