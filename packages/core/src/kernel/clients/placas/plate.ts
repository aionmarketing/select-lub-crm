/**
 * Brazilian plate parsing. Normalizes what an attendant typed and rejects anything
 * that is not a registrable plate, so a malformed value never becomes a billed
 * provider call.
 */

/** Old format `ABC1234`, or Mercosul `ABC1D23` (letter in the fifth position). */
const PLATE = /^[A-Z]{3}\d(?:[A-Z]\d{2}|\d{3})$/;

/**
 * Normalizes a plate and returns it only when it is a valid Brazilian plate.
 *
 * Drops every non-alphanumeric character and upper-cases, so `abc-1d23`,
 * `ABC 1D23` and `abc.1d23` all yield `ABC1D23`. Validation runs after
 * normalizing, so punctuation alone never causes a rejection.
 *
 * Returning the plate and rejecting in one call is deliberate: a caller cannot
 * normalize without also validating, which is what keeps an unchecked plate off
 * the paid path.
 *
 * @param input - Raw plate text as typed; may carry punctuation, spaces or lower case.
 * @returns The normalized plate, or `null` when it matches neither Brazilian format.
 */
export function parsePlate(input: string): string | null {
  const normalized = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return PLATE.test(normalized) ? normalized : null;
}
