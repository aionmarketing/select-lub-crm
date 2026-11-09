/**
 * Selects the assistive-suggestion rows for the build-time UI variant.
 *
 * `FieldSuggestion` and `SuggestedVehicleRow` are the only two of prefill's
 * seven exports antigravity restyles, so the split is taken around them and the
 * rest of `prefill.tsx` — `diffSegments` above all — stays single.
 */
import { UI_VARIANT } from "../uiVariant.js";
import {
  FieldSuggestion as FieldSuggestionAntigravity,
  SuggestedVehicleRow as SuggestedVehicleRowAntigravity,
} from "./prefill.suggestions.antigravity.js";
import {
  FieldSuggestion as FieldSuggestionCursor,
  SuggestedVehicleRow as SuggestedVehicleRowCursor,
} from "./prefill.suggestions.cursor.js";

const antigravity = UI_VARIANT === "antigravity";

/** Per-field assistive suggestion of the active variant. */
export const FieldSuggestion = antigravity
  ? FieldSuggestionAntigravity
  : FieldSuggestionCursor;

/** Suggested-vehicle ghost row of the active variant. */
export const SuggestedVehicleRow = antigravity
  ? SuggestedVehicleRowAntigravity
  : SuggestedVehicleRowCursor;
