/**
 * Reading a plate's cached vehicle fields from another module.
 *
 * `quotes` enriches the identity it sends to Motul with the displacement and
 * fuel a previous plate lookup resolved. That is a read of `plate_lookup`, a
 * table this module owns. `ownership.json` marks the table `readableBy: "*"`,
 * so the SELECT itself would be permitted from any module — this function
 * exists so the column's shape is interpreted in one place. `fields` is a
 * `Json?` column, where a stored miss is SQL NULL and a resolution is an
 * object; a caller re-implementing that mapping could read a miss as `{}`.
 */
import { parsePlate } from "../../../kernel/clients/placas/index.js";
import type { DbClient } from "../../../kernel/index.js";
import type { PlateSuggestionFields } from "./http.js";

/**
 * The fields a previous lookup resolved for a plate, if it resolved one.
 *
 * Never calls a provider and never bills: it reads the cache and nothing else,
 * so a plate that was never looked up stays un-looked-up.
 *
 * It takes the CALLER'S transaction and opens none of its own. The caller runs
 * it inside its own `db.tx("<its module>", …)`, so the read happens under the
 * caller's role, which the `readableBy: "*"` grant admits.
 *
 * @param tx - The caller's transaction client.
 * @param plate - The plate as the caller holds it; normalized here with
 *   `parsePlate` (idempotent), so a value already normalized is unchanged.
 * @returns The cached fields when the stored row is a resolution (any outcome
 *   other than `miss`, see below); `null` for a stored miss, a plate never
 *   cached, or input that is not a plate.
 */
export async function readCachedPlateFields(
  tx: DbClient,
  plate: string,
): Promise<PlateSuggestionFields | null> {
  const normalized = parsePlate(plate);
  if (!normalized) return null;
  const row = await tx.plateLookup.findUnique({
    where: { plate: normalized },
    select: { outcome: true, fields: true },
  });
  // Anything but "miss" counts as resolved, exactly as the adapter this
  // replaces read the column. The demo seed used to write `outcome: "found"`,
  // a value the production writer never uses; #132 corrected it, on update as
  // well, but a database seeded before that and not re-seeded still holds
  // "found" rows. A strict `=== "resolved"` would turn those into uncached
  // plates, silently dropping the displacement and fuel `quotes` sends to
  // Motul (W2-C8).
  if (!row || row.outcome === "miss" || row.fields === null) return null;
  return row.fields as PlateSuggestionFields;
}
