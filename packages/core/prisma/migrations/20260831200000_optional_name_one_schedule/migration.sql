-- AlterTable
ALTER TABLE "customer" ALTER COLUMN "name" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_message_one_non_cancelled_service" ON "scheduled_message"("service_id") WHERE "service_id" IS NOT NULL AND "status" <> 'CANCELLED';
