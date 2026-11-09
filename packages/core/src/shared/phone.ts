/**
 * How a phone number is written down, everywhere.
 *
 * A number reaches the system from Evolution (a JID), from the ERP, and from an
 * attendant typing it, in three different shapes. Comparing them without a
 * canonical form is what produced the duplicate-conversation class of bug, so
 * there is one function and both `conversations` and `customers` use it.
 *
 * Canonical form is digits only, with Brazil's country code, and no separators.
 */

/** Brazil. The only country the product serves today; stated rather than assumed. */
const COUNTRY_CODE = "55";

/**
 * Reduces a phone number as written to its canonical form.
 *
 * @param raw - A JID (`5511987654321@s.whatsapp.net`), a typed number
 *   (`(11) 98765-4321`), or anything with digits in it.
 * @returns Digits only, country code included, or `undefined` when there are
 *   too few digits to be a number. `undefined` rather than `""`, so a caller
 *   cannot store a blank and later compare it with another blank.
 */
export function canonicalPhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.split("@")[0]!.replace(/\D/g, "");
  if (digits.length < 10) return undefined;
  return digits.startsWith(COUNTRY_CODE) ? digits : `${COUNTRY_CODE}${digits}`;
}

/** Whether `value` is already canonical, for an assertion at a boundary. */
export function isCanonicalPhone(value: string): boolean {
  return canonicalPhone(value) === value;
}
