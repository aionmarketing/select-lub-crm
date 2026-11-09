/**
 * Cadastro prefill gating, stored-field projection, and LLM output normalization.
 */
import type { PrefillFields } from "../contracts/http.js";
import type { PrefillCadastroSnapshot } from "./cadastro-snapshot.js";

/**
 * Returns true when a string field is null, undefined, or whitespace-only.
 *
 * @param value - Candidate string field from cadastro or LLM output.
 * @returns True when the value is missing or trims to an empty string.
 */
export function isBlank(value: string | null | undefined) {
  return value == null || value.trim() === "";
}

/**
 * Treats missing name and phone-placeholder name as empty for prefill gating.
 *
 * @param name - Stored customer display name.
 * @param phoneNormalized - Conversation normalized phone used as a placeholder name.
 * @returns True when the name is blank or equals the normalized phone.
 */
export function nameIsEmpty(name: string | null, phoneNormalized: string) {
  return isBlank(name) || name === phoneNormalized;
}

/**
 * Returns true when any v1 customer or titular vehicle field is still empty.
 *
 * @param snapshot - Cadastro snapshot from {@link PrefillStore.resolveCadastro}.
 * @returns True when there is no linked customer or any v1 field is still empty.
 */
export function hasEmptyV1Field(snapshot: PrefillCadastroSnapshot) {
  if (!snapshot.customerId) {
    return true;
  }
  return (
    nameIsEmpty(snapshot.name, snapshot.phoneNormalized) ||
    isBlank(snapshot.taxId) ||
    isBlank(snapshot.plate) ||
    isBlank(snapshot.make) ||
    isBlank(snapshot.model) ||
    isBlank(snapshot.version) ||
    snapshot.year == null ||
    snapshot.odometerKm == null
  );
}

/**
 * Projects non-empty stored cadastro fields into v1 suggestion shape.
 *
 * @param snapshot - Cadastro snapshot with customer and titular vehicle fields.
 * @returns Only the v1 fields that already have stored values; may be an empty object.
 */
export function storedV1(snapshot: PrefillCadastroSnapshot): PrefillFields {
  const fields: PrefillFields = {};
  if (!nameIsEmpty(snapshot.name, snapshot.phoneNormalized) && snapshot.name) {
    fields.name = snapshot.name;
  }
  if (!isBlank(snapshot.taxId) && snapshot.taxId) {
    fields.taxId = snapshot.taxId;
  }
  if (!isBlank(snapshot.plate) && snapshot.plate) {
    fields.plate = snapshot.plate;
  }
  if (!isBlank(snapshot.make) && snapshot.make) {
    fields.make = snapshot.make;
  }
  if (!isBlank(snapshot.model) && snapshot.model) {
    fields.model = snapshot.model;
  }
  if (!isBlank(snapshot.version) && snapshot.version) {
    fields.version = snapshot.version;
  }
  if (snapshot.year != null) {
    fields.year = snapshot.year;
  }
  if (snapshot.odometerKm != null) {
    fields.odometerKm = snapshot.odometerKm;
  }
  return fields;
}

/**
 * Drops extracted fields that echo a stored value; keeps corrections that differ.
 * Then drops keys marked plate-sourced — those values are authoritative.
 *
 * @param extracted - Fields returned by the LLM after {@link pickV1Fields}.
 * @param stored - Fields already persisted on the customer/vehicle.
 * @param plateSourcedKeys - Veículo keys confirmed from a plate lookup; omitted keys are left alone.
 * @returns A copy of `extracted` with echoed stored values and plate-sourced keys removed.
 */
export function postFilterFilled(
  extracted: PrefillFields,
  stored: PrefillFields,
  plateSourcedKeys: readonly (keyof PrefillFields)[] = [],
): PrefillFields {
  const next: PrefillFields = { ...extracted };
  for (const key of Object.keys(extracted) as (keyof PrefillFields)[]) {
    if (stored[key] !== undefined && extracted[key] === stored[key]) {
      delete next[key];
    }
  }
  for (const key of plateSourcedKeys) {
    delete next[key];
  }
  return next;
}

/**
 * Normalizes raw LLM output to typed v1 prefill fields.
 *
 * @param raw - Unvalidated field map from the model response.
 * @returns Trimmed string fields and numeric year/odometer when valid; omits unsupported or empty values.
 */
export function pickV1Fields(raw: Record<string, unknown>): PrefillFields {
  const next: PrefillFields = {};
  if (typeof raw.name === "string" && raw.name.trim()) {
    next.name = raw.name.trim();
  }
  if (typeof raw.taxId === "string" && raw.taxId.trim()) {
    next.taxId = raw.taxId.trim();
  }
  if (typeof raw.plate === "string" && raw.plate.trim()) {
    next.plate = raw.plate.trim();
  }
  if (typeof raw.make === "string" && raw.make.trim()) {
    next.make = raw.make.trim();
  }
  if (typeof raw.model === "string" && raw.model.trim()) {
    next.model = raw.model.trim();
  }
  if (typeof raw.version === "string" && raw.version.trim()) {
    next.version = raw.version.trim();
  }
  if (typeof raw.year === "number" && Number.isInteger(raw.year)) {
    next.year = raw.year;
  }
  if (typeof raw.odometerKm === "number") {
    next.odometerKm = raw.odometerKm;
  }
  return next;
}
