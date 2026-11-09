-- AlterTable
ALTER TABLE "whatsapp_connection" ADD COLUMN "connection_state" TEXT NOT NULL DEFAULT 'DISCONNECTED';
ALTER TABLE "whatsapp_connection" ADD COLUMN "last_connected_at" TIMESTAMP(3);
ALTER TABLE "whatsapp_connection" ADD COLUMN "last_disconnected_at" TIMESTAMP(3);
ALTER TABLE "whatsapp_connection" ADD COLUMN "last_disconnect_reason" TEXT;
