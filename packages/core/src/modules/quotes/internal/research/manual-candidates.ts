/**
 * Persisting the manual candidates a pipeline run found (oil-source-candidates). Moved out of
 * `quote-options.ts` so the research runner (PR 3) can reuse it (background-oil-research D9).
 */
import type { ManualCandidate } from "../pipeline/oil-spec.js";
import type { OilQuoteStore, VehicleIdentity } from "../store/store.js";

/**
 * Records the documents retrieval found and did not read, insert-only
 * (oil-source-candidates "Every manual candidate is persisted, not counted").
 *
 * @param store - The quote's store.
 * @param identity - The vehicle they were found for.
 * @param candidates - From `resolveOilSpec`; none, nothing is written.
 */
export async function persistManualCandidates(
  store: Pick<OilQuoteStore, "insertSourceCandidates">,
  identity: VehicleIdentity,
  candidates: readonly ManualCandidate[] | undefined,
): Promise<void> {
  if (!candidates || candidates.length === 0) {
    return;
  }
  const foundAt = new Date().toISOString();
  await store.insertSourceCandidates(
    candidates.map((candidate) => ({
      make: identity.make,
      year: identity.year,
      model: identity.model,
      version: identity.version,
      url: candidate.url,
      publisher: candidate.publisher,
      classification: candidate.classification,
      tier: candidate.tier,
      discoveredVia: candidate.discoveredVia ?? null,
      label: candidate.label ?? null,
      selectionReason: candidate.selectionReason ?? null,
      foundAt,
    })),
  );
}
