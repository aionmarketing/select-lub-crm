-- ingest-harvested-manuals PR 1 (GitHub #77): storage for reading the manufacturer manuals the
-- oil-spec web search records in oil_source_candidate but cannot open.
--
-- Keyed by the document's URL (orchestrator, 2026-09-25): one manual can be a candidate for
-- several identities, and oil_source_candidate is insert-only with a row per find, so it is left
-- untouched and the work state lives here, once per URL.
--   oil_manual_ingestion  one row per document URL: pending, ingesting, ingested or refused.
--   oil_manual_document   one download: SHA-256 of the bytes read, size, pages, durations.
--                         Insert-only; the binary is not stored (owner, Q2).
--   oil_manual_page       the extracted text of each page, with its page number.
--   oil_manual_reading    one identity's reading of a manual (the spec depends on the engine,
--                         and a manual can list several): pending until the job reads it.
-- New tables only; nothing existing is altered and there is no backfill.

-- CreateTable
CREATE TABLE "oil_manual_ingestion" (
    "url" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "definite" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_manual_ingestion_pkey" PRIMARY KEY ("url")
);

-- CreateTable
CREATE TABLE "oil_manual_document" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "pages" INTEGER NOT NULL,
    "revision" TEXT,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "fetch_ms" INTEGER NOT NULL,
    "parse_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_manual_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_manual_page" (
    "document_id" TEXT NOT NULL,
    "page_number" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "oil_manual_page_pkey" PRIMARY KEY ("document_id","page_number")
);

-- CreateTable
CREATE TABLE "oil_manual_reading" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "document_id" TEXT,
    "spec" JSONB,
    "cited_page" TEXT,
    "excerpt" TEXT,
    "read_by" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_manual_reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oil_manual_document_url_fetched_at_idx" ON "oil_manual_document"("url", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "oil_manual_reading_url_make_year_model_version_key" ON "oil_manual_reading"("url", "make", "year", "model", "version");

-- AddForeignKey
ALTER TABLE "oil_manual_document" ADD CONSTRAINT "oil_manual_document_url_fkey" FOREIGN KEY ("url") REFERENCES "oil_manual_ingestion"("url") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_manual_page" ADD CONSTRAINT "oil_manual_page_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "oil_manual_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_manual_reading" ADD CONSTRAINT "oil_manual_reading_url_fkey" FOREIGN KEY ("url") REFERENCES "oil_manual_ingestion"("url") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oil_manual_reading" ADD CONSTRAINT "oil_manual_reading_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "oil_manual_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

