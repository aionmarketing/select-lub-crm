/**
 * Which of a customer's vehicles are being researched right now, for the rail
 * (background-oil-research D18; customers `list-conversation-vehicles`).
 *
 * A vehicle is marked while its identity's research is attended — running under an unexpired
 * lease, waiting for a manual, or queued at priority 0 — and research is not stopped (D15's
 * rules, `oil-research-attention.ts`). A car queued only for the backfill, an incomplete
 * identity, a verified one and a Tecfil consultation are not marked. The budget never holds
 * attended research (D13), so it does not enter the rule.
 *
 * It takes the CALLER's transaction and opens none of its own: `oil_research` and
 * `oil_research_runner` are `readableBy: "*"`, so the read runs under the caller's role. It
 * reads only: it writes nothing, starts no research, and calls no provider.
 */
import type { DbClient } from "../../../kernel/index.js";
import { identityKey, readResearchStopped, researchAttended, type IdentityFields } from "./oil-research-attention.js";

/** A vehicle as the rail lists it: an id and its identity fields. */
export type ResearchedVehicle = IdentityFields & { id: string };

/**
 * @param tx - The caller's transaction client.
 * @param vehicles - The vehicles to look up.
 * @param now - The server's clock, against which the leases are read.
 * @returns The ids of the vehicles whose identity's research is attended and not stopped.
 */
export async function readActiveOilResearch(tx: DbClient, vehicles: readonly ResearchedVehicle[], now: Date): Promise<Set<string>> {
  const keyed = vehicles.map((vehicle) => ({ id: vehicle.id, key: identityKey(vehicle) })).filter((entry): entry is { id: string; key: string } => entry.key !== null);
  if (keyed.length === 0) return new Set();
  const [rows, stopped] = await Promise.all([
    tx.oilResearch.findMany({
      where: { identityKey: { in: [...new Set(keyed.map((entry) => entry.key))] }, state: { in: ["queued", "running", "waiting_manual"] } },
      select: { identityKey: true, state: true, priority: true, leaseUntil: true },
    }),
    readResearchStopped(tx, now),
  ]);
  if (stopped) return new Set();
  const attended = new Set(rows.filter((row) => researchAttended(row, now)).map((row) => row.identityKey));
  return new Set(keyed.filter((entry) => attended.has(entry.key)).map((entry) => entry.id));
}
