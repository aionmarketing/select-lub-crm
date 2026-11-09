# create-quote

**Purpose.** Persist the quote the attendant sends to a customer, with every line frozen
at the price it was offered at, so a later catalog change never reaches a stored quote.

**Kind.** HTTP route — `POST /vehicles/:id/quotes`. Entry points: `createQuote(db, input)`,
the logic a test calls directly; `freezeLines(catalog, lines)`, the pure pricing rule; and
`route()`, which `createHttpPlugin` mounts. It takes no ports.

**Tables written** (`quotes`-owned, one `db.tx("quotes", …)` for the whole request):
`oil_quote`, `oil_quote_line`.
**Tables read:** the three catalog tables; and, as foreign reads under `readableBy: "*"`,
`vehicle` and `customer`.

**Invariants.**
- A filter line is frozen at the catalog's current price whatever the body sent (design
  D10); an oil line keeps the price it was offered at.
- A line naming an item the catalog lacks refuses the whole quote with 400, and nothing is
  written.
- A vehicle that does not exist and one owned by another unit both answer 404.
- The quote's author is the authenticated attendant (`created_by_user_id` is a foreign key
  to `user`, so it must be a real user).
- No provider call, so one transaction covers the read and the write.

**Tests.** `tests/create-quote.route.integration.test.ts`, 7 cases through `buildSliceApp`.
