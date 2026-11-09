# quotes/internal

Oil-change quote: a grounded oil-spec pipeline run as background research, the mock catalog, Tecfil cache reuse, and frozen persistence.

## Where it runs

**Research runs in the worker; a quote only reads** (background-oil-research). The worker's
`quotes/sweep-oil-research` queues every registered car with a complete identity, and
`quotes/run-oil-research` researches one identity at a time — a quote-open or a refetch first,
then a car registered in the last 24 h, then the paced backfill, which alone stops at the daily
budget (`OIL_RESEARCH_DAILY_BUDGET_USD`). It writes the cache rows and the identity's research
state (`oil_research`). `GET /vehicles/:id/quote-options` then reads those rows and that state and
**calls no provider**: no Motul, Tecfil, web search or model. While a car is still being
researched it answers `researching`, with the elapsed time from `requestedAt` and the stored X–Y
minutes. The api needs no provider key for quotes. Every research call goes to OpenAI
(`OIL_RESEARCH_MODEL`, default `gpt-6.1-sol`), streams, at the configured reasoning effort
(`OIL_RESEARCH_REASONING_EFFORT`, default `medium`), and ends at a ceiling of minutes, never at a
fixed short limit (`model-calls/`).

## How a card gets its price

`(catalog lubricant unit price × service-fill liters) + chosen oil filter + chosen fuel filter`

A catalog lubricant's `price` is **per liter**; a filter's `price` is per filter and is never multiplied. The liters are **service fill with filter** — the drain-and-refill volume. Each volume carries its capacity type (`fillCondition`, ingest-harvested-manuals D5): only `with_filter`, or a single `unlabeled` volume (the card then says "(volume sem legenda)"), multiplies. `without_filter` and dry fill (`Volume seco`) are recorded when a source states them but never multiply, because pouring a dry fill would overfill the engine and overquote the customer.

The liters are a cited source's, or the attendant's (D24.1): on a missing volume the attendant can type one, and "Guardar para este modelo" keeps it per identity (`oil_attendant_fill`, `../record-oil-fill-volume/`). A typed volume is a human input, never a source: no model sees it, and it is flagged on the cards. A sourced volume wins once research finds one.

## Where viscosity and liters come from

Never from a model's memory. The pipeline is: **cache → retrieve a citable source → extract from that source → validate → match the catalog**.

- An LLM only ever **reads a retrieved passage**. It extracts the SAE grade list and the service-fill volume. It does **not** decide which oil the workshop should sell, and it does **not** collapse several listed grades to one.
- Choosing which Motul / Lubrax / Ipiranga product to offer is plain catalog matching on SAE equality, after the spec is known.
- A source may list **more than one** SAE grade for one engine. The full list is kept, and a card is offered for every listed grade the catalog stocks.
- With no cited source, no key, or nothing extractable, research records no spec and the quote **says so in Portuguese**. It never invents a grade or a volume.
- Grades verified but no usable volume → `no_capacity`: the dialog carries the cards unpriced and asks the attendant for the volume (above), or prices them from a volume already kept for the identity. When the source gave only a volume a change does not use (without the filter, or dry), `no_capacity` names it (`unusableFill`).
- More than one engine matching the identity → `needs_clarification`, never the first option in silence. When the source named the engines, the attendant picks one: the version is corrected with it and the stored passage is read again for that engine alone (`engine_pick`, `../pick-oil-engine/`).
- Sources that still disagree after the escalation read → `conflicting_sources`, with a card per disputed grade, each cited to its source, and the disputed volumes as choices; the attendant picks.

The Motul Oil Advisor is one source among them, and it has answered HTTP 500 for over a month (owner, 2026-09-27): the stored manuals and the web search stand in for it, and a Motul outage is recorded as one, not as a miss. Once it has failed without an answer for `MOTUL_DEGRADED_AFTER_MS` (6 h; the runner row's `motul_failing_since`, owner 2026-10-07) it is *degraded*: its `unavailable` is answered `none`, so a run stays complete (it rests as `no_spec`, may wait for a manual, and no longer feeds the outage breaker). Every run still calls Motul, and any answer ends the state.

`db:seed` and `pnpm test` open no socket to Motul, Tecfil or OpenAI. Live adapter calls happen only in documented capture/ingest scripts.

## Web search

When no local adapter returns a source of tier 1–3, the research run asks a model with a web-search tool to find one. Everything about that path is a restriction:

- **The searching model classifies, code assigns the tier.** For each URL it says what kind of document the page is, with a one-line reason. `packages/core/src/kernel/prisma/source-tier.ts` maps that class to the tier: `manufacturer_manual` 1, `manufacturer_technical` 2, `licensed_database` 3, `lubricant_maker_guide` 4, `aftermarket_catalog` 5. A page classified `other` is rejected, and a tier number the model volunteers is ignored outright.
- **The model never writes a URL.** The search is OpenAI's hosted `web_search` tool, run once on the research model and forced to search. The candidates are the sources the tool reports it consulted (`web_search_call.action.sources`) and the pages it opened — never the reply text — and the reply is discarded. A second, strict-schema call is handed those candidates as a numbered list and asks only for each entry's document class, **by index**. Every URL in a candidate is copied from the tool's result at that index. Measured 2026-09-14 on the earlier search engine: asked to write URLs instead, the model produced 0 of 7–10 the tool had found — memory URLs are not a prompt problem, so they are made impossible by construction.
- **The engine is steered by location and language, on evidence.** OpenAI's `web_search` is sent an approximate Brazilian location (`user_location` BR / São Paulo) and a Portuguese prompt, because it has no language field. The 2026-10-12 benchmark on four real cars reached official manufacturer domains with tier 1–2 pages on all four. The earlier Zhipu engine (history) needed its `search-prime` variant for the same result: its other engines returned Chinese-web pages for these cars.
- **The extractor reads a passage, not a prefix.** Before extraction, `pipeline/passage-selector.ts` asks the research model for up to `OIL_SELECTOR_MAX_RANGES` LINE RANGES of the text about this vehicle's engine oil, over the page narrowed to its oil windows (background-oil-research D4), validates each against the page, and hands over those ranges plus a margin, completed in code so the grade lines and the capacities row both reach the extractor (D22) — or says `none`, in which case the page is not extracted at all. A short page is handed over whole without a call; a failed selection falls back to the narrowed text. The stored `sourceExcerpt` is those ranges, verbatim, joined by `[…]`.
- **A bare site root is not admitted.** `admitCandidate` rejects an empty path, `/` or an index file (`site root`), whatever the model called it: a front page states no vehicle's oil spec, and rejecting it before the fetch spends no attempt, no read and no selector call (oil-research-web-retrieval D2).
- **The blocklist is the floor, not a tiebreak.** `packages/core/fixtures/oil-source-blocklist.json` lists forum, social, marketplace, video and content-farm domains. It is checked *before* the classification, so no class the model can emit launders a blocked domain through. Matching is on the registrable domain plus its subdomains.
- **One model, one search.** The research model (`gpt-6.1-sol` at `medium`) searches here and extracts in `pipeline/spec-extractor.ts` — `prompt.md` routes "tool use and extraction" onto the same model — using OpenAI's own `web_search` tool and `OPENAI_API_KEY`. There is no escalation pass in the search: the earlier design ran a second, stronger model when the first found nothing above tier 3, and across every measured showcase run that pass accepted **zero** sources, so it was removed rather than kept as decoration.
- **What a gateway page contributes.** A manufacturer's "manuals" page is usually a link index: its prose never mentions oil, and its value is the documents it points at. Those same-origin documents are harvested from the raw HTML before reduction — from anchors, and from JSON-shipped links such as vw.com.br's `"documentPath"` — each with the **label** the page gives it (anchor text, or a `linkLabel` / `linkTitle` / `title` sibling), and recorded as manual candidates carrying `discoveredVia`, so #77 can tell a document someone classified from one we inferred from its neighbour. Up to 25 are recorded; over that, `retrieval/document-links.ts` asks the research model — labels and URLs, by index, no tool — which are about the vehicle, and records its one-line reason as `selectionReason`. That call spends from the quote's own budgets: it gets what is left under `WEB_SEARCH_TIMEOUT_MS` (as its outer bound, under its model's own idle time and ceiling, and it is not asked with under a second left), and its tokens go into the same tally the search log's `costUsd` is priced from. Without a key or a usable answer the page order decides, labelled first; an unlabelled document never displaces a labelled one. A recorded document is a lead, not a fact.
- **Candidates are a ledger of leads that concern the car.** A document is recorded only when `concernsModel` holds (`model-named.ts`, the test `manuals/select-candidates.ts` applies before queueing): the model is a whole word, ignoring case, accents and separators ("HR-V" is found in "hrv"), in its label — the search title when it names the model, or the link's label — or, with no label, in its decoded URL; a generic label is not rescued by the URL. The ledger therefore holds no price list or promotion's terms the model called a manual, and nothing it holds is unreadable to the manual pipeline (D3). The research run (`../run-oil-research/`) writes every manual candidate to `oil_source_candidate` after `resolveOilSpec` returns, whatever its status — a `no_spec` quote still records what it found — insert-only, so a repeat find adds a row. A reuse retrieves nothing and writes nothing. Nothing of it reaches the quote-options HTTP contract.
- **A search that found nothing — or found pages and verified nothing — is not bought again.** It is remembered in `oil_spec_search_miss` for `WEB_SEARCH_MISS_TTL_HOURS` (default a week) and the gate skips the search for that vehicle; the attendant's refetch still searches. A miss is never offered as a cache row. Only a search that COMPLETED is remembered: the provider answered, every admitted page was read, and every extraction ran. A provider or tool failure is `unavailable`, which research treats as an outage and retries (background-oil-research D10); a page left unread (a 5xx, 408 or 429, a timeout or network failure, or the read/attempt budget; a definite 4xx such as 404 or 403, and a robots.txt disallow, count as read, since a retry says the same — `leftUnread`) or an extraction that failed (no key, a timeout, an unparseable reply — `EXTRACTION_FAILED`, distinct from `null`, "read and silent") records nothing, so the run is incomplete and its retry searches again. A disabled or keyless search is "not searched" and is never remembered either. The miss is stamped with the gate's injectable clock.
- **Redirects.** A page that answers 301/302/303/307/308 is followed by hand, at most three hops (the HEAD and the GET share them), each one through the SSRF guard, the blocklist and the target's `robots.txt`, and only within the same host and port (`www.` is not a difference); another host or port, a `Location` with credentials, a blocked one, a fourth hop and a `Location`-less redirect are a definite `redirect` refusal, which leaves no page unread. The source is cited to the URL that answered, and two results that redirect to one page are read once (`retrieval/redirects.ts`, D1).
- **What is not fetched.** A PDF or other document is refused from its headers, never downloaded, and recorded as a *manual candidate* on the internal retrieval result and in the log — that is GitHub #77, which will own reading them. It never reaches the quote-options HTTP contract.
- **What is stored.** A verified web-grounded spec writes the URL, the derived tier, the model's classification and the passage the extractor read onto the cache row. The passage is why a quote stays auditable after the page changes; it is server-side only and never reaches the customer's message. Reuse of that row searches and fetches nothing.
- **Budget.** Per search, inside one research run: `WEB_SEARCH_MAX_FETCHES` caps pages **read**, `WEB_SEARCH_MAX_ATTEMPTS` caps URLs **tried** (a dead link or a refused PDF spends an attempt, not a read; admitted candidates are tried tier 1 first), and `WEB_SEARCH_TIMEOUT_MS` caps the clock. Any one exhausted ends the search and keeps whatever was already accepted. `WEB_SEARCH_ENABLED=false` turns the whole path off. The timeout is enforced **on** the model call, not read between steps — an earlier version only checked the clock before starting work and one search ran for 573 seconds. There is deliberately **no tight token cap** chosen from outside the model: it reasons before answering (the earlier model measured 1.7k–5.5k reasoning tokens for the same query), and a small cap truncated the reply to an empty string without erroring. Every production call instead carries a generous `max_output_tokens` (`OIL_RESEARCH_MAX_OUTPUT_TOKENS`, default 25,000, OpenAI's recommended reservation for reasoning plus output): a spend bound of at most US$ 0.25 of output per call, far above any answer. A reply it cuts is a model failure, retried as an outage, never a source that states nothing.
- **Grades that agree by subset agree.** Two sources conflict on grades only when each names a grade the other lacks; the verified spec lists the union, cited to the higher authority. Liters are compared as before.
- **Cost.** Every search log line carries `costUsd`: the model's tokens at its list price plus US$ 0.01 per `web_search` action (`WEB_SEARCH_PRICE_PER_CALL`), and an `open_page` action is charged the same until OpenAI's billing for it is confirmed (`WEB_SEARCH_BILL_PAGE_ACTIONS`). Measured 2026-10-12 on four real cars: US$ 0.07–0.12 per car, about four to five times the earlier search. The model and the prompt matter more than they did, so how often the tier 1–3 gate lets a search happen at all stays a real lever. `scripts/demo-web-search.ts` prints the measured spend per search.

A web-found source is otherwise an ordinary source: the engine-coverage check, the validator, authority ordering, conflict detection and the escalation read all apply to it unchanged.

## Layout

```
internal/
├── quote-answer/       what a quote answers: the one enqueue, then the caches and the research state; no provider (background-oil-research D15)
├── retrieval/          finding citable documents
├── model-named.ts      whether a text names the vehicle's model as a whole word: what a manual candidate must satisfy to be recorded and to be queued
├── pipeline/           reading them, and deciding what they say
├── model-calls/        how every research model call is made: effort, streaming limits, the usage meter (background-oil-research)
├── research/           background research: the identity key, the one enqueue, claims, outcomes, budget and estimate (background-oil-research; its own README)
├── catalog/            turning a verified spec into priced cards
├── manuals/            reading the manufacturer manuals the search records (ingest-harvested-manuals)
├── net/                the SSRF guard every untrusted URL goes through
├── store/              the cache row and the catalog, behind one port
├── motul-agent/        `runMotulAgent`, an LLM loop over Motul tools; nothing on the quote path imports it
└── scripts/            manual showcases; real network, never in `pnpm test`
```

Read it in that order and it tells a story: the worker's `run-oil-research` job claims an identity
from `research/`, `retrieval/` looks for documents, `pipeline/` reads them, and the run records the
cache row; a request to the `get-quote-options` slice then reads it through `quote-answer/`, and
`catalog/` prices the result. The HTTP routes are the slices' (`../get-quote-options/`,
`../refetch-oil-research/`, `../pick-oil-engine/`, `../record-oil-fill-volume/`,
`../create-quote/`), and the jobs are too (`../sweep-oil-research/`, `../run-oil-research/`,
`../ingest-manuals/`, `../read-manuals/`), not this folder's.

### quote-answer/ and cited-source.ts

- **cited-source.ts** — one source in its three shapes: the pipeline's citation, the cache's `source*` fields (with excerpt and class), and what the dialog shows (neither).
- **quote-answer/answer.ts** — `answerQuote`, shared by `GET quote-options` and `POST oil-research/refetch`: the one enqueue (a quote-open or a refetch at priority 0), then D15's table over the latest cache row, the stored Tecfil row and the identity's research row, in one short `quotes` transaction. It calls no provider.
- **quote-answer/research-view.ts** — pure: the `researching` / `refresh` timing from the stored anchor and estimate, D15's `paused` order, a newer attempt, a later conflict or clarification, and a resting identity's answer.
- **quote-answer/shown-row.ts** — pure: what a cache row yields (`options` / `empty` / `no_capacity`, each with its date) and the filter half from the stored fitment and the identity's Tecfil state.

### retrieval/ — finding citable documents

- **sources.ts** — the adapters in the source hierarchy's order: committed ingested passages first, then the stored manual readings, then Motul Oil Advisor as one application guide among sources, and finally the web adapter — gated by `gateWebSearch`, so it runs only when nothing local reached tier 1–3 (a source marked `sparesWebSearch: false` doesn't count).
- **stored-manuals.ts** — a verified manual reading as a source (ingest-harvested-manuals D6/D7). It is tier 1 or 2, carries the stored extraction (`stored_spec`, extracted in code), and is cited to its page. It is dropped unless every grade and the liters appear in its passage (`unanchoredValues`). Its liters price by the D5 capacity type, like every source's. A reading that covered several engines is still offered but doesn't spare the web search.
- **web-search.ts** — the web adapter (see *Web search* above): one search pass, admission, fetching, the per-search budget, gateway-link harvesting, and the structured log.
- **search-fn.ts** — the `SearchFn` port and `SearchUnavailableError`: a search that did not work throws, so it is never recorded as a miss.
- **openai-search.ts** — the OpenAI search step. One streamed Responses call runs the hosted `web_search` tool. It is forced to search, asked to stop at `WEB_SEARCH_MAX_SEARCHES` (a soft hint: the benchmark saw 2 calls for a cap of 1, so the code counts what happened and charges every action), located in BR / São Paulo, and given the blocklist's plain domains as `blocked_domains`. The candidates are the consulted sources and the opened pages, never the reply text. Then the code blocklist and the site-root rule remove candidates, and a strict-schema classification call runs over what is left. Fees are booked per tool-call item, with page actions charged unless `WEB_SEARCH_BILL_PAGE_ACTIONS=false`.
- **search-hits.ts** — queries, page keys, merging and formatting hits, the classification prompt and parsing its verdicts.
- **search-cost.ts** — list prices and the cost of one search from its token usage.
- **admit.ts** — the pure admission rule: blocklist first, then the classification→tier map. A candidate's own `tier` field is never read.
- **redirects.ts** — the hand-followed, same-host redirect loop `fetchPage` runs for its HEAD and its GET (D1).
- **page-fetcher.ts** — fetches one admitted page: public https only, through the SSRF guard (`../net/`, a `blocked` refusal counts as read), `robots.txt` honoured, no credentials, a HEAD content-type gate that refuses a document *before* the body is read, HTML reduced to capped plain text with table rows kept as lines, and `extractDocumentLinks` harvesting same-origin documents a gateway page links.
- **motul-lookup.ts** — `resolveOil` wrapper kept for the single-spec lookup; the quote path reaches Motul through `sources.ts` instead.

### pipeline/ — reading documents, and deciding what they say

- **oil-spec.ts** — the pipeline and its ports (`AuthoritativeSourceRetriever`, `OilSpecExtractor`), SAE normalization, the validator that clears an implausible or unlabeled volume, authority ordering, conflict detection and the single escalation read. A Motul flatten payload is extracted **deterministically here**, with no model call. Its types are the vocabulary the rest of the module speaks — start there.
- **fill-condition.ts** — the capacity type of a volume (ingest-harvested-manuals D5): with the filter, without it, dry, or unlabeled, read from an older `fillKind` when an extraction predates it. The validator prices `with_filter` and a single `unlabeled` volume, and keeps `without_filter` and `dry` aside as `unusableFillLiters`, so the dialog can say which volume it found (owner, 2026-09-26).
- **passage-selector.ts** — the research model chooses the line ranges of a text that are about this vehicle's engine oil, before the extractor reads it; an invalid range is dropped, the missing grades or capacities are added in code (D22), and a selection with no valid range falls back to the narrowed text. `narrow-text.ts` holds the narrowing and the anchor predicates.
- **spec-extractor.ts** — the extractor for prose, on the research model (`OPENAI_API_KEY`, `OIL_RESEARCH_MODEL`). The reply is read as text and the JSON object located inside it, so commentary the model adds around that object is discarded. One retry on malformed JSON, then a miss. Also hosts the conflict escalator.

### catalog/ — turning a verified spec into priced cards

- **match.ts** — active catalog rows whose viscosity equals **any** listed SAE grade (trim + case-insensitive). Classification (D13) and the oil type (`oilType`: SINTETICO / SEMISSINTETICO / MINERAL or null, add-lubricant-oil-type) ride on the lubricant-detail to the card and are never compared.
- **filters.ts** — active filter-detail rows whose part number equals a fitted Tecfil number or a cross-reference, normalized (uppercase, non-alphanumerics dropped); brand ignored.
- **tecfil-lookup.ts** — `resolveFilters` wrapper with the picker injected; tests inject a fake so Tecfil is never called.
- **tecfil-option-picker.ts** — LLM picker for a Tecfil name with no exact match. Uses `OPENAI_API_KEY` (deliberately a different provider from the spec extractor); the model comes from `TECFIL_PICKER_MODEL`, else `OPENAI_MODEL`, else the Motul agent's default. It can only return a label Tecfil listed, and returns no pick with no key, on `none`, on an out-of-list reply, or on any error. Research's wrapper tells a failure (no key, an error, an out-of-list reply) from `none`: a Tecfil `unmatched` after a picker failure is recorded `unavailable` and retried, never a resting `unmatched` (background-oil-research D12).

### store/ — the cache row and the catalog

- **store.ts** — port: catalog list/get (each row with its lubricant- or filter-detail), latest/insert CompatibilidadeMotul, latest/insert CompatibilidadeTecfil, createQuote.
- **prisma.ts** — the Postgres adapter, composed from **catalog.ts**, **compatibility-caches.ts**, **source-research.ts**, **manual-readings.ts** (the verified readings for an identity) and **quote-writes.ts**, one file per group of the port's methods; **column-readers.ts** holds the column parsing they share, and **grade-sources.ts** the `grade_sources` JSON — each grade's source and the liters', grouped by source on disk, flattened per grade on read, a NULL (pre-column) row read as its one primary source for everything (D11, owner 2026-09-25). Reads a pre-grounding row (no `viscosities`, no liters) as a one-entry grade list with unknown capacity. The slices hand it a client already inside `db.tx("quotes", …)`; `scripts/demo-retrieval.ts`, a transaction of its own that it rolls back.
- **attendant-fill.ts** — `oil_attendant_fill`, insert-only: the volume an attendant kept for an identity, with who and when; the latest row is the one read (D24.1).
- **vehicle-in-unit.ts** — a vehicle and its holder, only if it belongs to the caller's unit; every vehicle-scoped HTTP slice starts here.

### scripts/ — manual showcases

Every one makes real network calls, so none of them is ever part of `pnpm test` (D9).

- **demo-retrieval.ts** — the whole quote path by car model (`pnpm --filter @select-lub/api demo:oil-retrieval`).
- **demo-conflict.ts** — two disagreeing sources and the escalation read (`demo:oil-conflict`).
- **demo-web-search.ts** — the web adapter end to end, printing every candidate with its class, reason and derived tier, plus the token spend and cost of each search (`demo:oil-web-search`).
- **benchmark-openai.ts** — the OpenAI benchmark (switch-oil-research-to-openai D9). By default it is a dry run: it prints the plan for a capture file and makes no call. `--run` spends at most US$ 1.00, on OpenAI only. A group with no cases releases its cap to the searches (2026-10-12), and the repeatable `--search-identity "<make>|<year>|<model>|<version>"` adds cars to them (at most 5 in all); the dry run prints the effective caps. The guards, plan and caps are in **benchmark-plan.ts**, which is pure. **benchmark-openai-run.ts** is the paid run, imported only after those guards. Every model request in it goes through a transport that refuses any host but OpenAI's, and that checks the call's worst case against the caps before sending it.

### Tests

Unit tests sit beside the file they test (`*.test.ts`), all fakes and no sockets. Each file opens
with a design header naming the axes it samples, the decision map of the code under test, and what
it deliberately leaves out — which makes them the fastest way to learn intended behaviour without
reading the implementation.

Database-backed tests do **not** live here; they are the slices' own, in
`../<slice>/tests/`, on the real database inside the rollback harness.

### net/

- **guarded-http.ts:** `createGuardedHttp`, the one way this module reaches a URL it didn't choose (review of #180, SSRF).
  - https only.
  - No loopback, private, link-local (169.254.169.254 included), 0.0.0.0/8, CGNAT, `localhost` or `*.internal` destination.
  - The address is checked in the connection's own `lookup`, so it's the address dialled.
  - Redirects are followed by hand, each hop checked, at most five.
  - Bodies are capped.
  - Used by `manuals/document-fetcher.ts` and, through `guardedTransport`, by `retrieval/page-fetcher.ts`.

### manuals/

Reading the manufacturer PDFs `oil_source_candidate` records (GitHub #77). Choosing, downloading, parsing and storing (PRs 1–2), and locating, reading once per identity and using the reading as a source (PR 3), and the capacity type (PR 4). The reading is a source inside a research run, not at quote time: a run that found a manual waits for it (`waiting_manual`, `OIL_RESEARCH_MANUAL_WAIT_MS`, 30 min) and resolves the identity again, without a web search, when the reading ends. The notices are superseded by background research (background-oil-research D11, D20).

- **limits.ts:** the hard caps, from `MANUAL_*` with Q3's defaults (40 MB, 600 pages, 60 s fetch, 60 s parse), plus the reviews of #180's: 50,000 characters a page, 5,000,000 a document, a 256 MB JS heap for the parser, and 1024 MB of address space for the parser child on Linux. Q5 measured the recorded candidates (median 4.3 MB, max 14.5 MB).
- **document-fetcher.ts:** `fetchManual`, through the SSRF guard (`../net/`).
  - robots.txt first, then a HEAD: a status, a content type or a declared size that rules the document out ends there, with no download.
  - Then a GET whose body is cut at the byte cap whatever the headers said, under one timeout. The bytes must start `%PDF-`, whatever the content type says; an empty body is refused.
  - Each outcome is the bytes and their SHA-256, a **definite** refusal (a blocked URL, a 4xx other than 408/429, robots, not a PDF, empty, over the cap), or a **transient** failure (a 5xx, 408, 429, a timeout, a network error). A content type reaches the log only as a short token.
- **text-extractor.ts:** the `ManualTextExtractor` port, and its `unpdf` adapter (pdf.js 6.1, bundled).
  - On Linux the parse runs in a child process under `ulimit -v`, because pdf.js decodes into typed arrays outside the V8 heap and only an OS limit bounds a decompression bomb. Elsewhere it falls back to a `worker_threads` Worker with a heap limit.
  - Either way it's **killed** at the parse timeout, runs **one at a time** per process (the next waits for the last to exit), and gets an **empty environment**.
  - Text only: no fonts, no rendering.
  - Refuses a document over the page cap; a page or a document over the character caps, or one that runs the parser out of memory (`too_large`); a document with no text on any page (a scan); and anything that throws (`unreadable`). A parser that couldn't start is transient.
  - `text-extractor.process.test.ts` proves the child's limit, on Linux only.
- **read-manual.ts:** `readManual` = fetch, then `beforeParse`, then extract, with one log line per document (size, pages, fetch and parse ms), so the caps Q5 could not measure are checked in production. It never throws. The job commits the attempt in `beforeParse`; if that fails, nothing is parsed.
- **locate-pages.ts:** the D4 prefilter. It scores pages by oil words and the identity's engine words (the displacement both ways, the valve count, the engine code), keeps the top K (`MANUAL_PAGES_TO_SELECTOR`, 6), and joins them under `=== página N ===` markers, remembering each line's page. `pagesForLines` maps the selector's line range to "p. N" / "pp. N–M", only pages sent. A page's own marker-like line is defused.
- **read-for-identity.ts:** one identity's reading (D7): locate, select, extract once. The result is `verified` (valid grade), `stated_nothing` or `failed` (a model failure). It stores the raw extraction with the source's publisher, label and class; `parseStoredManualSpec` reads it back with zod.
- **reading-store.ts:** `claimNextReading` (a lease; the attempt counted; `failed` retried every 6 h, definite after three attempts), `loadReadingInput` (the latest document's pages, and the candidate's label and class) and `recordReading` (a compare-and-set on the claim's attempt).
- **select-candidates.ts:** `chooseManuals` (D1): tier 1–2 manufacturer classes; the model named as a whole word, in the label when there is one, else the URL; ranked by a year match, then `.com.br`, then labelled, then the recorded order.
- **ingestion-store.ts:** the job's reads and writes. `queueManuals` (one ingestion row per URL, one reading per identity; a refused or failed URL frees its place). `claimNextManual` (leased; counts the attempt; first marks every abandoned row out of attempts `failed`). `markParsing`, committed before the parse. `recordManualRead` (strips NUL). `recordManualFailure` (a definite refusal is terminal; a transient failure backs off, and is `failed` after three).
  - States: `pending` → `ingesting` → `parsing` → `ingested`, or the terminal `refused` / `failed`.
  - Every write after the claim is a compare-and-set on it (URL, expected state, claimed attempts). A count of 0 means the lease was lost: nothing is written, and the tick says `lost`. `recordManualRead` writes its state first, then the document.
- **fixtures/:** the test PDFs, authored by `make-fixtures.ts` and never downloaded. `manual-5-pages.pdf` has a fake capacities table on p. 3; `no-text-layer.pdf` has no text. No real manual is committed.
- **The tables** (all owned by `quotes`):
  - `oil_manual_ingestion`: one row per URL, the work state. `oil_source_candidate` stays insert-only and untouched.
  - `oil_manual_document`: one download, insert-only.
  - `oil_manual_page`.
  - `oil_manual_reading`: one per (URL, identity).

