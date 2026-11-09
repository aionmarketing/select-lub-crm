-- background-oil-research PR 2 (task 2.1): the research tables and state.
--
--   oil_research         one row per vehicle identity (D6): the research state, kind, priority,
--                        trigger, attempts and lease (D7-D10), the manual wait (D11), the stored
--                        estimate (D14), and Tecfil's own claim (D12). Keyed by identity_key, the
--                        caches' own normalization, with a unique index, so every caller's enqueue
--                        is one INSERT ... ON CONFLICT (identity_key) DO UPDATE ... WHERE.
--   oil_research_run     one run, Tecfil consultation or manual reading: timings, outcome, calls,
--                        tokens and cost (D3, D14). The day's spend is summed by started_at.
--   oil_research_runner  the runner's one row: the heartbeat, the key flag, the day's spend and
--                        budget, the pause and its end, the sweep watermark (D9, D13). The claim
--                        locks it FOR UPDATE, so research runs one at a time across processes.
-- New tables only; nothing existing is altered and there is no backfill (the sweep is the backfill).

-- CreateTable
CREATE TABLE "oil_research" (
    "id" TEXT NOT NULL,
    "identity_key" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "kind" TEXT NOT NULL DEFAULT 'full',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "trigger" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "queued_at" TIMESTAMPTZ(3) NOT NULL,
    "cycle_queued_at" TIMESTAMPTZ(3) NOT NULL,
    "requested_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "expected_min_s" INTEGER,
    "expected_max_s" INTEGER,
    "pending_kind" TEXT,
    "pending_priority" INTEGER,
    "pending_requested_at" TIMESTAMPTZ(3),
    "wait_started_at" TIMESTAMPTZ(3),
    "manual_wait_until" TIMESTAMPTZ(3),
    "sources_read_at" TIMESTAMPTZ(3),
    "searched" BOOLEAN NOT NULL DEFAULT true,
    "outcome" TEXT,
    "outcome_payload" JSONB,
    "current_run_id" TEXT,
    "tecfil_state" TEXT,
    "tecfil_lease_until" TIMESTAMPTZ(3),
    "tecfil_attempts" INTEGER NOT NULL DEFAULT 0,
    "tecfil_due_at" TIMESTAMPTZ(3),
    "tecfil_unmatched_field" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_research_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_research_run" (
    "id" TEXT NOT NULL,
    "research_id" TEXT,
    "identity_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "queued_at" TIMESTAMPTZ(3),
    "cycle_queued_at" TIMESTAMPTZ(3),
    "requested_at" TIMESTAMPTZ(3),
    "wait_started_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "stage_ms" JSONB,
    "glm_calls" INTEGER NOT NULL DEFAULT 0,
    "search_calls" INTEGER NOT NULL DEFAULT 0,
    "timed_out_calls" INTEGER NOT NULL DEFAULT 0,
    "tokens" JSONB,
    "usage_known" BOOLEAN NOT NULL DEFAULT true,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "efforts" JSONB,
    "picker_calls" INTEGER NOT NULL DEFAULT 0,
    "picker_tokens" JSONB,
    "picker_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_research_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_research_runner" (
    "id" TEXT NOT NULL DEFAULT 'runner',
    "last_seen_at" TIMESTAMPTZ(3),
    "key_set" BOOLEAN NOT NULL DEFAULT false,
    "day" TEXT,
    "day_spend_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "budget_usd" DECIMAL(12,6),
    "paused_reason" TEXT,
    "paused_until" TIMESTAMPTZ(3),
    "sweep_watermark" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_research_runner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oil_research_identity_key_key" ON "oil_research"("identity_key");

-- CreateIndex
CREATE INDEX "oil_research_claim_idx" ON "oil_research"("state", "priority", "requested_at", "queued_at", "id");

-- CreateIndex
CREATE INDEX "oil_research_run_started_at_idx" ON "oil_research_run"("started_at");

-- CreateIndex
CREATE INDEX "oil_research_run_path_finished_at_idx" ON "oil_research_run"("path", "finished_at");

-- AddForeignKey
ALTER TABLE "oil_research_run" ADD CONSTRAINT "oil_research_run_research_id_fkey" FOREIGN KEY ("research_id") REFERENCES "oil_research"("id") ON DELETE SET NULL ON UPDATE CASCADE;

