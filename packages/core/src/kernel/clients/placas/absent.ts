/**
 * Placeholder detection. Both providers return filler in place of data they do not
 * have — empty strings, whitespace, all-zero digit runs, a zero displacement, and
 * live `agregados-propria` labels `INDETERMINADO` / `DESCONHECIDO` — and none of
 * it may reach cadastro dressed as a real value.
 */

/** Registry filler labels observed on live `agregados-propria` 200s (case-insensitive). */
const ABSENT_LABELS = new Set(["INDETERMINADO", "DESCONHECIDO"]);

/**
 * Returns a trimmed string, or `undefined` when the provider sent a placeholder.
 *
 * Treats as absent: `undefined`, `null`, an empty or whitespace-only string, a
 * string whose characters are all zeros (`agregados-propria` sends `"00000000000"`
 * for an axle or chassis number it does not have), and the live filler labels
 * `INDETERMINADO` / `DESCONHECIDO` (any case). A value that merely *starts*
 * with a zero is kept, since leading zeros are meaningful in real identifiers.
 *
 * @param value - Raw field from a provider response; may be any type the JSON carried.
 * @returns The trimmed string, or `undefined` when the value is missing or filler.
 */
export function absentString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^0+$/.test(trimmed)) return undefined;
  if (ABSENT_LABELS.has(trimmed.toUpperCase())) return undefined;
  return trimmed;
}

/**
 * Returns a positive integer, or `undefined` when the provider sent a placeholder.
 *
 * Accepts a number or a numeric string, since the two providers disagree on the
 * type they use for displacement and model year. Zero and negatives are absent:
 * no engine has zero displacement, and `agregados-basica` sends `0` for a
 * displacement it does not know.
 *
 * @param value - Raw field from a provider response; may be a number or a string.
 * @returns The integer, or `undefined` when it is missing, unparseable, or not positive.
 */
export function absentPositiveInt(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : absentString(value);
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const truncated = Math.trunc(parsed);
  return truncated > 0 ? truncated : undefined;
}
