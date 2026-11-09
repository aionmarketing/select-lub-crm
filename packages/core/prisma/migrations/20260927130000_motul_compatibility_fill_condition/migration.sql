-- ingest-harvested-manuals PR 4 (D5): the capacity type of a cached spec's volume. fill_condition
-- is with_filter or unlabeled for the priced fill_liters, or without_filter or dry for a volume a
-- change does not use, kept in unusable_fill_liters and never priced. Additive: both nullable with
-- no backfill, so a row written before this reads its capacity type from fill_kind.
ALTER TABLE "motul_compatibility" ADD COLUMN "fill_condition" TEXT;
ALTER TABLE "motul_compatibility" ADD COLUMN "unusable_fill_liters" DECIMAL(6,3);
