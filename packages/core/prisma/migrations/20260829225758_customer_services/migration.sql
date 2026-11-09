-- CreateTable
CREATE TABLE "service" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "unit_id" TEXT NOT NULL,
    "omie_id" TEXT,
    "performed_at" TIMESTAMP(3),
    "description" TEXT,
    "kind" TEXT,
    "status" TEXT,
    "amount" DECIMAL(10,2),
    "odometer_km" DOUBLE PRECISION,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_item" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit_amount" DECIMAL(10,2),
    "line_amount" DECIMAL(10,2),
    "oil_viscosity" TEXT,
    "oil_brand" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_omie_id_key" ON "service"("omie_id");

-- CreateIndex
CREATE INDEX "service_customer_id_idx" ON "service"("customer_id");

-- CreateIndex
CREATE INDEX "service_item_service_id_idx" ON "service_item"("service_id");

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
