-- DropIndex
DROP INDEX "vehicle_customer_id_key";

-- CreateIndex
CREATE INDEX "vehicle_customer_id_idx" ON "vehicle"("customer_id");
