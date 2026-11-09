-- ingest-harvested-manuals PR 3 (review of #182): a reading's retries are bounded by a count, not
-- by how long ago it was queued. The claim counts each attempt; a reading that has had three is
-- a definite `failed` and is not claimed again. Existing rows start at 0.
ALTER TABLE "oil_manual_reading" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
