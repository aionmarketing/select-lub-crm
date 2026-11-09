/**
 * Demo-seed opt-out. Default is on so `db:seed` fills screens locally.
 * Set `SEED_DEMO=0` or `SEED_DEMO=false` to keep only the base seed.
 */
export function isDemoSeedEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.SEED_DEMO?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/**
 * Returns whether the TIDSCI-derived mock dataset opt-in is set.
 *
 * Seed never reads `tid_archive` or `.local/` JSON; the worker pull does that
 * import. This flag only documents the path: demo seed must not create
 * `TIDSCI EMP0N` units when it is on, and `SEED_DEMO=0`/`false` skips TIDSCI
 * even if a dump file exists.
 *
 * @param env - Environment map.
 * @returns `true` when `OMIE_MOCK_DATASET` trims to `"tidsci"`.
 */
export function isTidsciMockDataset(env: NodeJS.ProcessEnv = process.env) {
  return env.OMIE_MOCK_DATASET?.trim() === "tidsci";
}

/**
 * Returns whether demo seed plus the TIDSCI dataset flag are both on.
 *
 * When this is false (including `SEED_DEMO=0` with a dump on disk), seed must
 * not create TIDSCI-derived customers.
 *
 * @param env - Environment map.
 * @returns `true` only when demo seed is enabled and `OMIE_MOCK_DATASET=tidsci`.
 */
export function shouldFollowTidsciMockImport(env: NodeJS.ProcessEnv = process.env) {
  return isDemoSeedEnabled(env) && isTidsciMockDataset(env);
}
