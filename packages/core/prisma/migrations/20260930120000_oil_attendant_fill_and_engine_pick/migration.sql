-- background-oil-research PR 5 (tasks 5.8 and 5.13; design D24): the attendant's ways out of
-- the three dead ends. Additive only: one new table and new nullable (or defaulted) columns,
-- with no backfill.
--
--   oil_attendant_fill   a fill volume an attendant typed for a vehicle identity whose cited
--                        sources gave no usable liters (quotes/oil-attendant-fill). Insert-only:
--                        the latest row per identity_key is the one read, so every value typed
--                        stays auditable. A human input, never a cited source: no publisher,
--                        document, page, URL or excerpt, and research never reads it.
--   oil_research         the engine_pick kind's columns (D10, D24): the engine picked, the identity
--                        the clarification rested on, a copy of the passages it re-reads (each with
--                        publisher, document, page, URL, tier, class and excerpt), and whether the
--                        pick reopened a resting outcome, which a re-read that does not verify
--                        keeps (G2).

-- CreateTable
CREATE TABLE "oil_attendant_fill" (
    "id" TEXT NOT NULL,
    "identity_key" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "liters" DECIMAL(6,2) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_attendant_fill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oil_attendant_fill_identity_key_recorded_at_idx" ON "oil_attendant_fill"("identity_key", "recorded_at");

-- AddForeignKey
ALTER TABLE "oil_attendant_fill" ADD CONSTRAINT "oil_attendant_fill_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "oil_research" ADD COLUMN "engine_pick_engine" TEXT;
ALTER TABLE "oil_research" ADD COLUMN "engine_pick_from" TEXT;
ALTER TABLE "oil_research" ADD COLUMN "engine_pick_passages" JSONB;
ALTER TABLE "oil_research" ADD COLUMN "engine_pick_reopened" BOOLEAN NOT NULL DEFAULT false;
