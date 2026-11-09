-- Two insert-only ledgers for the oil-spec retrieval.
--
-- `oil_source_candidate` keeps the documents the search found and deliberately did not read
-- — manufacturer PDFs refused by the content-type gate, and documents harvested from a
-- gateway page's links. Until now only a COUNT of them survived the request, so the best
-- finds of every search (real owner-manual PDFs) evaporated; GitHub #77 will read them.
-- `discovered_via` separates a document the searching model classified itself from one that
-- merely inherited its page's class, and `label` / `selection_reason` record why a harvested
-- one was kept. Insert-only: finding the same URL again on a later quote adds a row and
-- leaves the earlier one alone, so the history of what was visible when is intact.
--
-- `oil_spec_search_miss` remembers that a search for one vehicle identity found nothing, so
-- the next quote for the same car does not pay for the same empty search. It is NOT a cache
-- row: it can never be offered to the attendant as a previous result and never carries a
-- spec — which is exactly why it is a separate table rather than a column on
-- motul_compatibility, where a row means "a verified spec".

-- CreateTable
CREATE TABLE "oil_source_candidate" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "discovered_via" TEXT,
    "label" TEXT,
    "selection_reason" TEXT,
    "found_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_source_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oil_spec_search_miss" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "searched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oil_spec_search_miss_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oil_source_candidate_year_make_model_version_idx" ON "oil_source_candidate"("year", "make", "model", "version");

-- CreateIndex
CREATE INDEX "oil_spec_search_miss_year_make_model_version_idx" ON "oil_spec_search_miss"("year", "make", "model", "version");
