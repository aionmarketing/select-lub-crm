-- Generic catalog item: rename product_line → description, add stock.
ALTER TABLE "catalog_item" ADD COLUMN "description" TEXT;
ALTER TABLE "catalog_item" ADD COLUMN "stock" DECIMAL(12,3);

UPDATE "catalog_item" SET "description" = "product_line", "stock" = 0;

ALTER TABLE "catalog_item" ALTER COLUMN "description" SET NOT NULL;
ALTER TABLE "catalog_item" ALTER COLUMN "stock" SET NOT NULL;

-- Frozen quote lines follow the same rename.
ALTER TABLE "oil_quote_line" ADD COLUMN "description" TEXT;

UPDATE "oil_quote_line" SET "description" = "product_line";

ALTER TABLE "oil_quote_line" ALTER COLUMN "description" SET NOT NULL;

-- One lubricant-detail row per existing catalog item (all current rows are oils).
CREATE TABLE "catalog_lubricant" (
    "catalog_item_id" TEXT NOT NULL,
    "viscosity" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "catalog_lubricant_pkey" PRIMARY KEY ("catalog_item_id")
);

INSERT INTO "catalog_lubricant" ("catalog_item_id", "viscosity", "classification")
SELECT "id", "viscosity", "classification" FROM "catalog_item";

ALTER TABLE "catalog_lubricant" ADD CONSTRAINT "catalog_lubricant_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog_item" DROP COLUMN "product_line";
ALTER TABLE "catalog_item" DROP COLUMN "viscosity";
ALTER TABLE "catalog_item" DROP COLUMN "classification";

ALTER TABLE "oil_quote_line" DROP COLUMN "product_line";
