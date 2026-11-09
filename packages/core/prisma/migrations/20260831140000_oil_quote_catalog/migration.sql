-- CreateTable
CREATE TABLE "motul_compatibility" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "viscosity" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "consulted_at" TIMESTAMP(3) NOT NULL,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "motul_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "product_line" TEXT NOT NULL,
    "viscosity" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_quote" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "generated_message_text" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oil_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_quote_line" (
    "id" TEXT NOT NULL,
    "oil_quote_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "product_line" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "oil_quote_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "motul_compatibility_year_make_model_version_idx" ON "motul_compatibility"("year", "make", "model", "version");

-- CreateIndex
CREATE INDEX "oil_quote_customer_id_idx" ON "oil_quote"("customer_id");

-- CreateIndex
CREATE INDEX "oil_quote_vehicle_id_idx" ON "oil_quote"("vehicle_id");

-- CreateIndex
CREATE INDEX "oil_quote_line_oil_quote_id_idx" ON "oil_quote_line"("oil_quote_id");

-- AddForeignKey
ALTER TABLE "oil_quote" ADD CONSTRAINT "oil_quote_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_quote" ADD CONSTRAINT "oil_quote_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_quote" ADD CONSTRAINT "oil_quote_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_quote" ADD CONSTRAINT "oil_quote_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_quote_line" ADD CONSTRAINT "oil_quote_line_oil_quote_id_fkey" FOREIGN KEY ("oil_quote_id") REFERENCES "oil_quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_quote_line" ADD CONSTRAINT "oil_quote_line_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
