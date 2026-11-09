/**
 * Money settings parse strictly (background-oil-research D3).
 *
 * A budget, a price or a charge accepts a finite number ≥ 0 written with a dot. Anything else —
 * blank, `1,00`, `abc`, `-1` — is logged once with its name and the default is used. `Number()`
 * would turn `""` into 0 and `"1,00"` into `NaN`, and `spend >= NaN` is false for ever: a typo
 * must never switch a cap off. A deliberate `0` is valid.
 */

import { parseMoney } from "../../../../kernel/money.js";

/** Parses one money value; the kernel's rule, shared with the worker's budget setting. */
export { parseMoney };

const reported = new Set<string>();

/** Forgets what was reported; tests call it so each can see its own warning. */
export function resetMoneyReportsForTests(): void {
  reported.clear();
}

/**
 * A money setting from the environment: unset gives the default silently; set to anything that
 * does not parse gives the default and is logged once.
 *
 * @param name - The variable's name.
 * @param fallback - The default.
 */
export function moneySetting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = parseMoney(raw);
  if (value !== null) return value;
  const key = `${name}|${raw}`;
  if (!reported.has(key)) {
    reported.add(key);
    console.warn("money-setting", JSON.stringify({ outcome: "invalid", name, value: raw, using: fallback }));
  }
  return fallback;
}
