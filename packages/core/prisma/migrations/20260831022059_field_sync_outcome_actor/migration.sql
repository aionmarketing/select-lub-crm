-- AlterTable
ALTER TABLE "customer_field_sync" ADD COLUMN     "changed_by" TEXT,
ADD COLUMN     "last_attempted_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_result" TEXT;

-- AlterTable
ALTER TABLE "vehicle_field_sync" ADD COLUMN     "changed_by" TEXT,
ADD COLUMN     "last_attempted_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_result" TEXT;
