/**
 * First-upsert unit assignment for TIDSCI-derived mock clients.
 *
 * Unvalidated mapping (GitHub #27 / #29 / #5): one mock tenant, the existing
 * primary unit, never four EMP shops.
 */

/**
 * Returns the unit id to set on a **new** customer when the TIDSCI dataset is
 * selected. Existing customers must not be moved; fixture mock (flag unset)
 * returns `null` so the create path stays `unitId: null`.
 *
 * @param dataset - `OMIE_MOCK_DATASET` value; only `"tidsci"` assigns a unit.
 * @param units - CRM units, preferably including one named `Select Lub`. Oldest
 *   should be first when the name is missing so the caller can pass `[oldest]`.
 * @returns `Select Lub`'s id, else the first unit's id, else `null`.
 */
export function unitIdForNewTidsciCustomer(
  dataset: string | undefined,
  units: Array<{ id: string; name: string }>,
): string | null {
  if (dataset?.trim() !== "tidsci") {
    return null;
  }
  const named = units.find((unit) => unit.name === "Select Lub");
  return named?.id ?? units[0]?.id ?? null;
}
