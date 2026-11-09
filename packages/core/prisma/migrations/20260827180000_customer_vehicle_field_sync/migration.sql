-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "omie_id" TEXT,
    "tax_id" TEXT,
    "unit_id" TEXT,
    "given_name" TEXT,
    "family_name" TEXT,
    "merged_into_id" TEXT,
    "street" TEXT,
    "street_number" TEXT,
    "neighborhood" TEXT,
    "complement" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_phone" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_phone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_email" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "omie_id" TEXT,
    "plate" TEXT,
    "make" TEXT,
    "model" TEXT,
    "version" TEXT,
    "year" INTEGER,
    "odometer_km" INTEGER,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_field_sync" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "local_version" INTEGER NOT NULL DEFAULT 0,
    "external_version" INTEGER NOT NULL DEFAULT 0,
    "synced_local_version" INTEGER NOT NULL DEFAULT 0,
    "synced_external_version" INTEGER NOT NULL DEFAULT 0,
    "last_omie_wire" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_field_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_field_sync" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "local_version" INTEGER NOT NULL DEFAULT 0,
    "external_version" INTEGER NOT NULL DEFAULT 0,
    "synced_local_version" INTEGER NOT NULL DEFAULT 0,
    "synced_external_version" INTEGER NOT NULL DEFAULT 0,
    "last_omie_wire" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_field_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_reconciliation_pending" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "crm_value" TEXT NOT NULL,
    "omie_value" TEXT NOT NULL,
    "local_version" INTEGER NOT NULL,
    "external_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_reconciliation_pending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_reconciliation_pending" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "crm_value" TEXT NOT NULL,
    "omie_value" TEXT NOT NULL,
    "local_version" INTEGER NOT NULL,
    "external_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_reconciliation_pending_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_omie_id_key" ON "customer"("omie_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_customer_id_key" ON "vehicle"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_field_sync_customer_id_field_key_key" ON "customer_field_sync"("customer_id", "field_key");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_field_sync_vehicle_id_field_key_key" ON "vehicle_field_sync"("vehicle_id", "field_key");

-- CreateIndex
CREATE UNIQUE INDEX "customer_reconciliation_pending_customer_id_field_key_key" ON "customer_reconciliation_pending"("customer_id", "field_key");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_reconciliation_pending_vehicle_id_field_key_key" ON "vehicle_reconciliation_pending"("vehicle_id", "field_key");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phone" ADD CONSTRAINT "customer_phone_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_email" ADD CONSTRAINT "customer_email_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_field_sync" ADD CONSTRAINT "customer_field_sync_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_field_sync" ADD CONSTRAINT "vehicle_field_sync_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_reconciliation_pending" ADD CONSTRAINT "customer_reconciliation_pending_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_reconciliation_pending" ADD CONSTRAINT "vehicle_reconciliation_pending_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
