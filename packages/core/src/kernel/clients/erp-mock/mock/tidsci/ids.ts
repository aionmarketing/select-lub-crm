/**
 * Deterministic 10–12 digit mock Omie ids derived from stable source tuples.
 */
import { createHash } from "node:crypto";

const TEN_DIGITS = 10n ** 9n;
const THIRTEEN_DIGITS = 10n ** 12n;

/**
 * Allocates a digits-only mock Omie id from a source tuple, incrementing when
 * the hash collides with an already issued id.
 *
 * Keys must be processed in sorted order by the caller so collisions resolve
 * the same way on every run. The id is 10–12 decimal digits (Omie
 * `codigo_cliente_omie` shape) and never includes `emp01` or a `tidsci-` prefix.
 *
 * @param sourceKey - Stable tuple such as `client|cpf|52998224725`.
 * @param used - Ids already issued in this generate pass; mutated when a new id is taken.
 * @returns A 10–12 digit decimal string unique within `used`.
 */
export function allocateOmieLookingId(sourceKey: string, used: Set<string>): string {
  const digest = createHash("sha256").update(sourceKey).digest("hex");
  let n = BigInt(`0x${digest}`) % THIRTEEN_DIGITS;
  if (n < TEN_DIGITS) {
    n += TEN_DIGITS;
  }
  while (used.has(n.toString())) {
    n += 1n;
    if (n >= THIRTEEN_DIGITS) {
      n = TEN_DIGITS;
    }
  }
  const id = n.toString();
  used.add(id);
  return id;
}

/**
 * Returns whether a visible mock id is a 10–12 digit decimal string.
 *
 * @param id - Candidate id from the generator.
 * @returns `true` when `id` is digits only and length is 10, 11, or 12.
 */
export function isOmieLookingId(id: string): boolean {
  return /^\d{10,12}$/.test(id);
}
