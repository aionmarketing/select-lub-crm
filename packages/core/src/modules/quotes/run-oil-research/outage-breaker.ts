/**
 * The outage breaker (background-oil-research D9, step 3): after `limit` consecutive transient
 * outages on different identities — a refused request parameter and a rate-limit release
 * included — research pauses as a provider-wide refusal would. Any run that ends otherwise resets
 * the streak. Per process: two workers on one database each keep their own, and the pause they
 * write is shared through the runner row.
 */
export type OutageBreaker = {
  /** Counts an outage of `identityKey`; true when the streak reached the limit (the streak then restarts). */
  outage(identityKey: string): boolean;
  /** A run that was not an outage. */
  reset(): void;
};

/** @param limit - `OIL_RESEARCH_OUTAGE_BREAKER`. */
export function createOutageBreaker(limit: number): OutageBreaker {
  let streak = new Set<string>();
  return {
    outage(identityKey) {
      streak.add(identityKey);
      if (streak.size < limit) return false;
      streak = new Set();
      return true;
    },
    reset() {
      streak = new Set();
    },
  };
}
