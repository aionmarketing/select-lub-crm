/**
 * Decides how `db:seed` should treat the Select Lub unit's Baileys WhatsApp connection.
 *
 * @param existingByName - Row already stored under the env instance name, or `null` if that name is unused.
 * @param baileysForUnit - All `EVOLUTION_BAILEYS` rows for the seeded unit (any instance name).
 * @returns `noop` if the env name already exists; `rename` of the sole Baileys row when the name differs;
 *   `create` when there is not exactly one Baileys row to rename.
 */
export function planWhatsAppConnectionSeed(
  existingByName: { id: string } | null,
  baileysForUnit: { id: string }[],
) {
  if (existingByName) {
    return { action: "noop" as const };
  }
  if (baileysForUnit.length === 1) {
    const [existingBaileys] = baileysForUnit;
    if (!existingBaileys) {
      throw new Error("expected one EVOLUTION_BAILEYS connection for unit Select Lub");
    }
    return { action: "rename" as const, id: existingBaileys.id };
  }
  return { action: "create" as const };
}
