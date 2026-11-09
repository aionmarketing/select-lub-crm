-- oil-quote-retrieval-hardening D11, revised by the owner 2026-09-25: each SAE grade, and
-- the liters, cited to their own source. One nullable JSON column, the grade entries
-- grouped by source ({ grades: [{ grades, publisher, document, page, authority, url,
-- classification, excerpt }], liters: {...} | null }). No backfill: a NULL row reads as one
-- provenance, its source_* columns, for every grade and the liters.
ALTER TABLE "motul_compatibility" ADD COLUMN "grade_sources" JSONB;
