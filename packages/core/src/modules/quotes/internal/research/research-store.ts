/**
 * The research store (background-oil-research D7, D9, D10, D12, D14): the one enqueue every caller
 * goes through, the claims, and every write a claim makes afterwards. Each function runs on a
 * client already inside `db.tx("quotes", …)`; nothing here calls a provider, and no transaction
 * is meant to stay open across one.
 *
 * - {@link enqueueResearch}: one `INSERT … ON CONFLICT (identity_key) DO UPDATE … WHERE`, with
 *   adoption on insert and D7's table by state. The `WHERE` writes only when something changes,
 *   so a repeat enqueue (a 3 s poll) writes nothing, and two racing enqueues both answer with one
 *   row and no `P2002`.
 * - {@link claimNextResearch}: under the runner-row lock, one due row by a MATERIALIZED CTE with
 *   `FOR UPDATE` (no SKIP LOCKED, see claim.ts), in the order priority, `requested_at`, `queued_at`, id — a research
 *   claim (with adoption and abandonment first) or a Tecfil claim, never two at once.
 * - After a claim, every write is a compare-and-set: on `(id, state = running, attempts,
 *   current_run_id)` for research ({@link renewResearchLease}, {@link recordResearch},
 *   {@link releaseResearch}) and on `(id, tecfil_state = running, current_run_id)` for Tecfil
 *   ({@link renewTecfilLease}, {@link recordTecfil}, {@link releaseTecfil}). A lost one writes
 *   nothing — not the identity, not the run row, not the cache.
 * - {@link sweepExpiredLeases}: an expired research lease is queued again with its attempt counted,
 *   or `failed` when the cycle has none left; an expired Tecfil lease goes back to Tecfil
 *   `pending`, due now, and never touches the spec.
 */
export * from "./enqueue.js";
export * from "./claim.js";
export * from "./record.js";
export * from "./release.js";
export type { RunProgress } from "./run-progress.js";
