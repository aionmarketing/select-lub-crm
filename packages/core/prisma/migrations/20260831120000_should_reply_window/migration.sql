-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "last_prefill_window_closed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "message" ADD COLUMN "should_reply" BOOLEAN;

-- Existing threads are unlabeled history: stamp the watermark so a derived
-- window poll does not treat pre-change inbound rows as a live silence window.
UPDATE "conversation" SET "last_prefill_window_closed_at" = CURRENT_TIMESTAMP WHERE "last_prefill_window_closed_at" IS NULL;
