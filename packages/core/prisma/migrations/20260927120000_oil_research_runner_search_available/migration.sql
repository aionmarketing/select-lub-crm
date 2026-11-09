-- background-oil-research PR 4 (orchestrator ruling, review of #188): the runner's heartbeat
-- records whether it can web-search right now (WEB_SEARCH_ENABLED and a search key), so a
-- quote-open re-opens a no_spec recorded `searched: false` only while a search could actually
-- run. Additive; a row written before it reads as "search not available", which re-opens nothing.
ALTER TABLE "oil_research_runner" ADD COLUMN "search_available" BOOLEAN NOT NULL DEFAULT false;
