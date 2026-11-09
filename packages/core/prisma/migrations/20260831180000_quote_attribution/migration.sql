-- CreateTable
CREATE TABLE "service_quote_attribution" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_quote_attribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_quote_attribution_service_id_key" ON "service_quote_attribution"("service_id");

-- AddForeignKey
ALTER TABLE "service_quote_attribution" ADD CONSTRAINT "service_quote_attribution_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_quote_attribution" ADD CONSTRAINT "service_quote_attribution_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "oil_quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
