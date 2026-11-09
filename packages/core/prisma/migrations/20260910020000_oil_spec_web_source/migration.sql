-- What a web-found source leaves behind: the class the searching model gave the page
-- (the tier was derived from it) and the passage the extractor read. The passage matters
-- only for the web: a fixture keeps its excerpt in the committed file and a Motul payload
-- is reproducible, but a page can be edited or vanish and take the evidence with it.
-- Both nullable, so every existing row stays readable and untouched.

-- AlterTable
ALTER TABLE "motul_compatibility" ADD COLUMN "source_classification" TEXT;
ALTER TABLE "motul_compatibility" ADD COLUMN "source_excerpt" TEXT;
