-- CreateTable
CREATE TABLE "tecfil_compatibility" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manufacturer_label" TEXT NOT NULL,
    "vehicle_label" TEXT NOT NULL,
    "engine_label" TEXT,
    "matched_by" JSONB NOT NULL,
    "oil_filters" JSONB NOT NULL,
    "fuel_filters" JSONB NOT NULL,
    "consulted_at" TIMESTAMP(3) NOT NULL,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tecfil_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_filter" (
    "catalog_item_id" TEXT NOT NULL,
    "filter_type" TEXT NOT NULL,
    "part_number" TEXT NOT NULL,

    CONSTRAINT "catalog_filter_pkey" PRIMARY KEY ("catalog_item_id")
);

-- CreateIndex
CREATE INDEX "tecfil_compatibility_year_make_model_version_idx" ON "tecfil_compatibility"("year", "make", "model", "version");

-- AddForeignKey
ALTER TABLE "catalog_filter" ADD CONSTRAINT "catalog_filter_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
