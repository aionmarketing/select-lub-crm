/**
 * Plate-lookup helpers for the Conversas vehicle form: blur gating, silent
 * fill vs overwrite confirmation, keep/fail mark clearing, and save bodies.
 *
 * `parsePlate` matches `packages/core/src/kernel/clients/placas/plate.ts` so a malformed plate
 * never becomes a billed `POST /plate-lookups`.
 */
import type {
  PlateSuggestionFields,
  Vehicle,
  VehicleCreateBody,
  VehicleFieldEdit,
} from "@select-lub/shared-types";

/** Old format `ABC1234`, or Mercosul `ABC1D23` (letter in the fifth position). */
const PLATE = /^[A-Z]{3}\d(?:[A-Z]\d{2}|\d{3})$/;

/** Veículo identity keys a lookup may fill. `plate` and `odometerKm` are never marked. */
export const IDENTITY_FIELD_KEYS = ["make", "model", "version", "year"] as const;

/** One of make/model/version/year. */
export type IdentityFieldKey = (typeof IDENTITY_FIELD_KEYS)[number];

/** Portuguese labels for the four identity keys, used in overwrite copy. */
export const IDENTITY_FIELD_LABELS: Record<IdentityFieldKey, string> = {
  make: "Marca",
  model: "Modelo",
  version: "Versão",
  year: "Ano",
};

/** Draft the Adicionar veículo dialog and the rail editor share. */
export type VehicleFormDraft = {
  plate: string;
  make: string;
  model: string;
  version: string;
  year: string;
  odometerKm: string;
};

/** Blank draft for the six typeable vehicle fields. No system field appears here. */
export function emptyVehicleDraft(): VehicleFormDraft {
  return { make: "", model: "", version: "", year: "", plate: "", odometerKm: "" };
}

/**
 * Copies stored vehicle columns into the shared draft shape.
 *
 * @param vehicle - Saved vehicle row, including `plateSourcedKeys`.
 */
export function draftFromVehicle(vehicle: Vehicle): VehicleFormDraft {
  return {
    plate: vehicle.plate ?? "",
    make: vehicle.make ?? "",
    model: vehicle.model ?? "",
    version: vehicle.version ?? "",
    year: vehicle.year == null ? "" : String(vehicle.year),
    odometerKm: vehicle.odometerKm == null ? "" : String(vehicle.odometerKm),
  };
}

/**
 * Normalizes a plate and returns it only when it is a valid Brazilian plate.
 *
 * @param input - Raw plate text as typed; may carry punctuation, spaces or lower case.
 * @returns The normalized plate, or `null` when it matches neither Brazilian format.
 */
export function parsePlate(input: string): string | null {
  const normalized = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return PLATE.test(normalized) ? normalized : null;
}

/**
 * Decides whether a plate-field blur should run a lookup.
 *
 * Keystrokes never call this. A `failed` previous lookup of the same plate is
 * retried, because a provider error is transient and is not remembered
 * (plate-lookup spec, "A failure is retried silently"). A `found`,
 * `not_found` or `unavailable` result for the same plate is not repeated:
 * the first two are cached answers, and `unavailable` means the capability
 * has no APIBrasil credentials configured at all (plate-lookup spec,
 * "Provider selection resolves credentials, then mock, then unavailable"),
 * which is a static condition no amount of re-blurring can change. An
 * unchanged stored plate with no lookup yet in this visit is not looked up.
 *
 * @param typed - Current plate field text.
 * @param storedNormalized - Normalized plate already saved, or `null` on create.
 * @param lastCompleted - Last lookup finished in this visit, if any.
 * @returns The normalized plate to look up, or `null` to skip.
 */
export function shouldLookupOnPlateBlur(
  typed: string,
  storedNormalized: string | null,
  lastCompleted: { plate: string; status: "found" | "not_found" | "failed" | "unavailable" } | null,
): string | null {
  const normalized = parsePlate(typed);
  if (!normalized) {
    return null;
  }
  if (lastCompleted?.plate === normalized) {
    if (lastCompleted.status === "failed") {
      return normalized;
    }
    return null;
  }
  if (lastCompleted == null && storedNormalized === normalized) {
    return null;
  }
  return normalized;
}

/**
 * Trims the four identity fields from a draft.
 *
 * @param draft - Current form values.
 */
export function identityFromDraft(draft: VehicleFormDraft): Record<IdentityFieldKey, string> {
  return {
    make: draft.make.trim(),
    model: draft.model.trim(),
    version: draft.version.trim(),
    year: draft.year.trim(),
  };
}

/**
 * Maps a lookup suggestion onto draft identity strings. Omitted keys become `""`.
 *
 * @param fields - Suggestion from `POST /plate-lookups`.
 */
export function suggestionAsDraft(fields: PlateSuggestionFields): Record<IdentityFieldKey, string> {
  return {
    make: fields.make ?? "",
    model: fields.model ?? "",
    version: fields.version ?? "",
    year: fields.year == null ? "" : String(fields.year),
  };
}

function allIdentityEmpty(identity: Record<IdentityFieldKey, string>): boolean {
  return IDENTITY_FIELD_KEYS.every((key) => identity[key] === "");
}

/**
 * Identity keys whose draft value differs from the suggestion (including a
 * suggestion that clears a filled field).
 *
 * @param current - Current identity draft.
 * @param fields - Lookup suggestion.
 */
export function changingIdentityKeys(
  current: Record<IdentityFieldKey, string>,
  fields: PlateSuggestionFields,
): IdentityFieldKey[] {
  const next = suggestionAsDraft(fields);
  return IDENTITY_FIELD_KEYS.filter((key) => current[key] !== next[key]);
}

/** How a found lookup should change the form before any cadastro write. */
export type FoundLookupDecision =
  | { action: "noop" }
  | {
      action: "silent-fill";
      next: Record<IdentityFieldKey, string>;
      sourcedKeys: IdentityFieldKey[];
      changedKeys: IdentityFieldKey[];
    }
  | {
      action: "confirm";
      changing: IdentityFieldKey[];
      suggestion: Record<IdentityFieldKey, string>;
    };

/**
 * Applies the re-derivation skip rules: silent fill when all four fields are
 * empty, nothing when the result equals what is stored, otherwise confirm.
 *
 * @param current - Current identity draft.
 * @param fields - Lookup suggestion.
 */
export function decideFoundLookup(
  current: Record<IdentityFieldKey, string>,
  fields: PlateSuggestionFields,
): FoundLookupDecision {
  const suggestion = suggestionAsDraft(fields);
  const changedKeys = changingIdentityKeys(current, fields);
  if (changedKeys.length === 0) {
    return { action: "noop" };
  }
  const sourcedKeys = IDENTITY_FIELD_KEYS.filter((key) => suggestion[key] !== "");
  if (allIdentityEmpty(current)) {
    return { action: "silent-fill", next: suggestion, sourcedKeys, changedKeys };
  }
  return { action: "confirm", changing: changedKeys, suggestion };
}

/**
 * Overwrite: identity takes the suggestion, and filled suggestion keys are marked.
 *
 * @param suggestion - Draft identity after overwrite.
 */
export function overwriteFromSuggestion(suggestion: Record<IdentityFieldKey, string>): {
  sourcedKeys: IdentityFieldKey[];
} {
  return {
    sourcedKeys: IDENTITY_FIELD_KEYS.filter((key) => suggestion[key] !== ""),
  };
}

/**
 * Builds the create body from the dialog draft.
 *
 * Blank fields are omitted. Identity keys the attendant declined after a
 * suggestion are omitted even if the draft still holds text. `plateSourcedKeys`
 * lists marked keys that are actually sent.
 *
 * @param draft - Current dialog values, all as typed text.
 * @param plateSourcedKeys - Keys still marked plate-sourced in this visit.
 * @param declinedSuggestionKeys - Suggestion keys the attendant unchecked.
 */
export function createBodyFromDraft(
  draft: VehicleFormDraft,
  plateSourcedKeys: readonly IdentityFieldKey[] = [],
  declinedSuggestionKeys: readonly IdentityFieldKey[] = [],
): VehicleCreateBody {
  const declined = new Set(declinedSuggestionKeys);
  const text = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const includeIdentity = (key: IdentityFieldKey, value: string) => {
    if (declined.has(key)) {
      return undefined;
    }
    return text(value);
  };
  const year = includeIdentity("year", draft.year);
  const odometer = draft.odometerKm.trim();
  const make = includeIdentity("make", draft.make);
  const model = includeIdentity("model", draft.model);
  const version = includeIdentity("version", draft.version);
  const sent: IdentityFieldKey[] = [];
  if (make) sent.push("make");
  if (model) sent.push("model");
  if (version) sent.push("version");
  if (year) sent.push("year");
  const sourced = plateSourcedKeys.filter((key) => sent.includes(key));
  return {
    ...(make ? { make } : {}),
    ...(model ? { model } : {}),
    ...(version ? { version } : {}),
    ...(text(draft.plate) ? { plate: text(draft.plate) } : {}),
    ...(year === undefined ? {} : { year: Number(year) }),
    ...(odometer === "" ? {} : { odometerKm: Number(odometer) }),
    ...(sourced.length > 0 ? { plateSourcedKeys: sourced } : {}),
  };
}

/**
 * Builds a rail PATCH from the editor draft. Every displayed column is sent
 * (null when blank) so omitted-key origin rules do not hide an attendant clear.
 *
 * @param draft - Current editor values.
 * @param plateSourcedKeys - Keys still marked plate-sourced in this visit.
 */
export function patchFromDraft(
  draft: VehicleFormDraft,
  plateSourcedKeys: readonly IdentityFieldKey[],
): VehicleFieldEdit {
  const year = draft.year.trim();
  const odometer = draft.odometerKm.trim();
  return {
    plate: draft.plate.trim() ? draft.plate.trim() : null,
    make: draft.make.trim() ? draft.make.trim() : null,
    model: draft.model.trim() ? draft.model.trim() : null,
    version: draft.version.trim() ? draft.version.trim() : null,
    year: year === "" ? null : Number(year),
    odometerKm: odometer === "" ? null : Number(odometer),
    plateSourcedKeys: [...plateSourcedKeys],
  };
}
