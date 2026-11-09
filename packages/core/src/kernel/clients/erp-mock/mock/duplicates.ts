/**
 * Port for mock duplicate-client candidate pairs.
 *
 * Unvalidated stand-in: merge execution is GitHub #5. Callers MUST surface the pair
 * only — no `mergedInto` write, no row deletion.
 */
import type { MockDuplicatePair } from "./dataset.js";

/** Lists mock duplicate-client pairs. Never opens a network connection. */
export type OmieDuplicateCandidatesPort = {
  /**
   * Returns every mock duplicate pair.
   *
   * @returns Cloned `{ leftOmieId, rightOmieId }` rows.
   */
  listDuplicatePairs(): Promise<MockDuplicatePair[]>;
};

/**
 * In-memory duplicate-candidate port seeded from the mock dataset.
 *
 * @param rows - Dataset clone the source owns.
 * @returns Port whose `listDuplicatePairs` returns a clone of `rows`.
 */
export function createMockDuplicateCandidatesPort(
  rows: MockDuplicatePair[],
): OmieDuplicateCandidatesPort {
  return {
    async listDuplicatePairs() {
      return structuredClone(rows);
    },
  };
}
