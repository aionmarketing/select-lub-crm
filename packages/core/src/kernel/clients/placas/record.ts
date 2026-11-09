/**
 * Narrows unknown JSON to a plain object so adapters can read named keys
 * without throwing when a provider sends an array, null, or a primitive.
 */

/**
 * Returns `value` as a string-keyed object, or `undefined` when it is not one.
 *
 * @param value - Parsed JSON node; arrays are rejected so index keys are not treated as fields.
 * @returns The object, or `undefined`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
