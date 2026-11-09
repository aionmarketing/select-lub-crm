/**
 * Strict parsing of a money setting (background-oil-research D3): a finite number ≥ 0 written
 * with a dot. `Number()` would read `""` as 0 and `"1,00"` as `NaN`, and `spend >= NaN` is false
 * for ever, so a typo could switch a cap off. A deliberate `0` is valid.
 *
 * In the kernel because the worker's settings parse the daily budget with it; the quotes
 * module's price settings use the same rule (`modules/quotes/internal/model-calls/money.ts`).
 */

const MONEY = /^\d+(?:\.\d+)?$/;

/**
 * @param raw - The raw text.
 * @returns The number, or `null` when it is not a finite number ≥ 0 written with a dot.
 */
export function parseMoney(raw: string): number | null {
  const text = raw.trim();
  if (!MONEY.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
