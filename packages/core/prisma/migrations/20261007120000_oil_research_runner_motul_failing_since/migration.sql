-- oil-research-web-retrieval D6 (owner, 2026-10-07): since when the Motul Oil Advisor has been failing
-- without an answer, kept on the runner's one row so every worker process sees the same value.
-- A run stamps it on its first unavailable answer and clears it on any other; after
-- MOTUL_DEGRADED_AFTER_MS (6 h) of continuous failure Motul is degraded and no longer makes a run
-- incomplete. Additive only: one nullable column, no backfill; old code ignores it.

-- AlterTable
ALTER TABLE "oil_research_runner" ADD COLUMN "motul_failing_since" TIMESTAMPTZ(3);
