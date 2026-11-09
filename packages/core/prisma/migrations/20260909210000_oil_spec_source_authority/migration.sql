-- Source tier and URL on the verified-spec cache. The tier is what makes the prompt.md
-- rule enforceable: a lower-authority source must not silently override a higher one,
-- and nothing could apply that while no row knew its own tier. Both nullable so rows
-- written before this column stay readable.

-- AlterTable
ALTER TABLE "motul_compatibility" ADD COLUMN "source_authority" INTEGER;
ALTER TABLE "motul_compatibility" ADD COLUMN "source_url" TEXT;
