/**
 * Maps prefill job/suggestion persistence state to the shared {@link PrefillSuggestion} DTO.
 * Shared by memory and Prisma prefill stores and accept/reject route logic.
 */
import type { PrefillFieldKey, PrefillFields, PrefillSuggestion } from "../contracts/http.js";

/**
 * Derives sidebar status from in-flight jobs, stored fields, and last job outcome.
 *
 * @param input - Whether a job is running, current suggested fields, last job status string, and the persisted extraction switch.
 * @returns {@link PrefillSuggestion} discriminated by `extracting`, `pending`, `failed`, or `empty`, always with `extractEnabled`.
 */
export function mapPrefillView(input: {
  inFlight: boolean;
  fields: PrefillFields;
  lastJobStatus: string | null;
  extractEnabled: boolean;
}): PrefillSuggestion {
  const extractEnabled = input.extractEnabled;
  if (input.inFlight) {
    return { status: "extracting", extractEnabled };
  }
  if (Object.keys(input.fields).length > 0) {
    return { status: "pending", fields: input.fields, extractEnabled };
  }
  if (input.lastJobStatus === "failed") {
    return { status: "failed", extractEnabled };
  }
  return { status: "empty", extractEnabled };
}

/**
 * True when the suggestion map contains the given field key.
 *
 * @param fields - Raw suggested cadastro fields from persistence.
 * @param field - Field key to check for presence.
 * @returns Whether `field` is an own property of `fields`.
 */
export function suggestionHasField(fields: PrefillFields, field: PrefillFieldKey) {
  return Object.hasOwn(fields, field);
}

/**
 * Returns a copy of the suggestion with one field removed.
 *
 * @param fields - Current suggested cadastro fields.
 * @param field - Field key to remove after accept or reject.
 * @returns New {@link PrefillFields} object without `field`; does not mutate `fields`.
 */
export function stripPrefillField(fields: PrefillFields, field: PrefillFieldKey): PrefillFields {
  const next = { ...fields };
  delete next[field];
  return next;
}
