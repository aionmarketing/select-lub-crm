-- AlterTable
ALTER TABLE "message" ADD COLUMN "provider_status" TEXT;
ALTER TABLE "message" ADD COLUMN "sent_at" TIMESTAMP(3);
ALTER TABLE "message" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "message" ADD COLUMN "read_at" TIMESTAMP(3);
ALTER TABLE "message" ADD COLUMN "failed_at" TIMESTAMP(3);
ALTER TABLE "message" ADD COLUMN "content_unavailable" BOOLEAN NOT NULL DEFAULT false;
