-- AlterTable
ALTER TABLE "outbox_message" ADD COLUMN "message_type" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "outbox_message" ALTER COLUMN "text_body" DROP NOT NULL;
ALTER TABLE "outbox_message" ADD COLUMN "media_bytes" BYTEA;
ALTER TABLE "outbox_message" ADD COLUMN "media_mime_type" TEXT;
ALTER TABLE "outbox_message" ADD COLUMN "media_file_name" TEXT;

-- AlterTable
ALTER TABLE "message" ADD COLUMN "media_mime_type" TEXT;
ALTER TABLE "message" ADD COLUMN "media_file_name" TEXT;
