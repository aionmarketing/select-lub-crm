-- add-lubricant-oil-type (owner and orchestrator rulings, 2026-10-10): the base-oil type of a
-- catalog lubricant, shown on the quote card and in the message's "Tipo" line. Optional: a row
-- written before this column has none, and nothing here guesses one (ruling 1). Informative
-- only — offers still match on viscosity alone (ruling 4).
--
-- TEXT with a CHECK rather than a Postgres enum, as conversation.source_type does: the
-- repository has no enum types, and a NULL passes the CHECK. Additive only: one nullable
-- column, no default, no backfill; old code ignores it.

-- AlterTable
ALTER TABLE "catalog_lubricant" ADD COLUMN "oil_type" TEXT;

ALTER TABLE "catalog_lubricant"
  ADD CONSTRAINT "catalog_lubricant_oil_type_check"
  CHECK ("oil_type" IN ('SINTETICO', 'SEMISSINTETICO', 'MINERAL'));
