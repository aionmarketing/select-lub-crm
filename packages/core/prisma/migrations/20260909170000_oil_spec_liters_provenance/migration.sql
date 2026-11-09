-- Verified oil spec on the identity cache: every SAE grade the cited source listed, the
-- service-fill liters the quote multiplies by, and where that came from.
-- All columns are nullable so existing rows stay readable: a historical row keeps only
-- "viscosity", which the API reads as a one-entry grade list with unknown liters.

-- AlterTable
ALTER TABLE "motul_compatibility" ADD COLUMN "viscosities" JSONB;
ALTER TABLE "motul_compatibility" ADD COLUMN "fill_liters" DECIMAL(6,3);
ALTER TABLE "motul_compatibility" ADD COLUMN "fill_kind" TEXT;
ALTER TABLE "motul_compatibility" ADD COLUMN "source_publisher" TEXT;
ALTER TABLE "motul_compatibility" ADD COLUMN "source_document" TEXT;
ALTER TABLE "motul_compatibility" ADD COLUMN "source_page" TEXT;
