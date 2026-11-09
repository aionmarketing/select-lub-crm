# Tour run — Conversas inbox (list, search, thread, send, tags, Nova conversa)

## Feature

The attendant's front door: the unit-scoped thread list, its search and tag
filter, opening a thread, sending a text through the outbox, and starting a
conversation from a phone number.

Change under tour: `exploratory-tour-tests`, task 5.3 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness and the task 5.1/5.2 page
objects and seed extension.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API this session cannot kill; same guards applied on private ports. See `2026-09-10-app-shell.md`. |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`; paid-provider credentials blanked; `SERVER_URL` → mock Evolution; `EVOLUTION_WEBHOOK_URL` empty |
| Worker | **not started** — which is why a sent message stays `queued`, and why nothing can reach WhatsApp |
| Database | per-worktree local Postgres on 5433 |
| Seed | `seedE2eFixtures()` including the task 5.2 extension (customer `E2E Turista`, two vehicles, a unit tag) |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | The inbox is the screen every attendant starts on, and no browser test had walked list → search → thread → send → tag in one pass. |
| Rumo Errado | Decadente | Two legal controls used illegally: Enviar with nothing typed, and a search for a string that matches nothing. Both are states the screen must state rather than break in. |
| Período Chuvoso | Hoteleiro | Nova conversa is a form with a commit at the end. Abandoning it halfway must not leave a thread behind. |
| Ator Coadjuvante | Entretenimento | The tag filter shares the toolbar with search, and the tag *apply* control lives in the contact rail — a different region of the same screen. Applying in one place must change the list in the other. |

Left out: Colecionador (the inbox has one output shape, not several), Museu (this
code is not what the change edits), and the media/attachment paths, which need
fixtures this seed does not carry.

## Guidebook

From `openspec/specs/conversas/spec.md`:

- Phone digits find the thread
- Name search is case-insensitive
- Empty search match is explicit
- Unknown is not labelled organic
- Send queues an outbound text
- Empty send is rejected
- Apply from the open conversation
- Single tag filter

From `openspec/specs/tags-templates/spec.md`:

- Inbox filter by tag — Filter keeps matching threads

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Load `/` | Inbox listed 31 threads (demo dataset plus the five e2e fixtures) | conversas — List is scoped to the current unit | succeeded |
| 2 | Search `11999000005` | Exactly one row, `e2e-conv-tour`, labelled `E2E Turista`, origin chip `Desconhecida` | conversas — Phone digits find the thread; Unknown is not labelled organic | succeeded |
| 3 | Search `e2e turista` (lower case) | Same single row | conversas — Name search is case-insensitive | succeeded |
| 4 | Open the row | Thread rendered: header `E2E Turista` and `11999000005`, the seeded inbound `oi`, a composer, and the contact rail with both seeded vehicles (`ABC1D23`, `XYZ9K88`) | conversas — Thread is ordered by WhatsApp time; Contact rail lists vehicles | succeeded |
| 5 | Type `Tour Guiado inbox mensagem`, activate Enviar | Composer cleared; the message appeared in the thread marked **`queued`** — not sent | conversas — Send queues an outbound text | succeeded |
| 6 | Read the mock Evolution log | Empty for the whole run | conversas — the CRM queues, the worker sends (worker not started) | succeeded |

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 7 | Activate Enviar with an empty composer | Nothing queued and **no request left the page** — the API log shows no message POST between the surrounding reads | conversas — Empty send is rejected | succeeded |
| 8 | Search `zzzz-nao-existe-zzzz` | Zero rows and the explicit line `Nenhuma conversa para "zzzz-nao-existe-zzzz"`, naming the term back | conversas — Empty search match is explicit | succeeded |

### Tour do Ator Coadjuvante

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 9 | Activate `Aplicar E2E Turista Tag` in the contact rail | The rail's Tags block switched from an apply control to an applied chip | conversas — Apply from the open conversation | succeeded |
| 10 | Clear the search, activate the `E2E Turista Tag` filter chip in the toolbar | List narrowed from **31 to 1**, and that one is the conversation tagged in step 9 | tags-templates — Filter keeps matching threads; conversas — Single tag filter | succeeded |
| 11 | Activate the `Todas` chip | List returned to 31 | conversas — Applied filters are visible and removable | succeeded |

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 12 | Activate `Nova conversa` | Dialog `Nova conversa` opened with a `Telefone` field, the hint `Somente dígitos, com DDD`, and `Iniciar` **disabled** while empty | conversas — Nova conversa opens or creates a 1:1 thread | succeeded |
| 13 | Type `11988887777`, then activate `Cancelar` | Dialog closed; list still 31; no thread for that number anywhere; main pane still populated | Período Chuvoso — cancel mid-operation leaves no partial write | succeeded |

## Diagnosis

**The drive began against a dead session, and that is finding 1 below.** Every
CRM call answered 401 for several minutes before step 1 could run. The stored
Supabase token was *not* expired by the machine clock and was structurally
valid; calling `/api/auth/me` from the page with that exact token returned 401,
while a fresh password grant from node returned 200 on the same endpoint.
Clearing `sb-*-auth-token` from `localStorage` and reloading recovered fully.

While diagnosing it I saw tokens whose `iat` was roughly **27 000 seconds
(7.6 hours) in the future** relative to this machine. The owner later confirmed
the machine's clock was wrong by that amount, which closes the loop: Supabase
stamps real-time `iat`/`exp`, so the stored token really had expired after its
one-hour lifetime — it only *looked* 6.6 h from expiry against a clock that was
7.6 h behind. The rejection was an ordinary expiry. The defect is what the SPA
does next: `hydrateMvpSession` takes any stored session on trust and never
reaches its password-grant fallback, so an expired session is re-applied on
every reload until storage is cleared by hand.

**Zero console errors and zero 5xx** across the whole inbox drive once the
session was clean.

**Transcription hit the same class of race as the shell tour.** The first run of
the Ator Coadjuvante spec failed counting the unfiltered list: `inbox()`
resolves the panel, which exists before its rows arrive, so the count read `0`
and the "more than one thread" guard fired. Fixed by waiting for the first row
before counting — without it the later narrowing assertion would have compared
zero against one and passed for the wrong reason. Same lesson as before: the
interactive drive is more forgiving of timing than the spec it produces.

**`Enviar` is enabled with an empty composer.** The spec's requirement is that
an empty send is *rejected*, and it is — step 7 produced no request at all. The
button being clickable rather than disabled is a UX difference, not a scenario
violation, so it is recorded below rather than pinned.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | defect — fixed by change `session-recovery` | A session that goes bad mid-life is never recovered and the SPA retries forever. `hydrateMvpSession` (`apps/web/src/AppProviders.tsx:104`) snapshots `access_token` once at boot with no `onAuthStateChange` subscription, and returns before its password-grant fallback, so a reload re-applies the same dead token: console errors climbed from 6 to 188+ in about three minutes of idling. Recovery required manually clearing browser storage. | **Fixed** by change `session-recovery` (`openspec/changes/session-recovery/`), which first specified it: the `auth` spec had no scenario for a good session starting to be refused, so a fix inside a testing change would have been inventing the requirement. Three parts. `AuthHydrate` now subscribes to `onAuthStateChange` and mirrors `TOKEN_REFRESHED`/`SIGNED_IN`/`SIGNED_OUT` into the store, so a token the client refreshes in the background is the one that gets sent. A 401 from `GET /auth/me` during hydration is read as a refused session rather than an unknown unit, and triggers `recoverSession()` — which nulls the bearer, clears the client's storage with `signOut({ scope: "local" })`, and re-grants — while `parse()` reports any mid-life 401 through a small `sessionRecovery.ts` registry that keeps the HTTP layer free of auth policy. And the TanStack Query `retry` is now `retryUnlessRefused`, so a refused token is never retried; that unbounded retry is what turned a dead session into the 401 storm rather than a merely stale screen. A loop guard makes a recovery whose OWN fresh token is refused terminal. **Pinned** by `apps/web/src/AppProviders.session-recovery.test.ts` (twelve cases that await `recoverSession()` directly, no mounting) and four mounted end-to-end cases in `apps/web/src/AuthHydrate.test.tsx`. **Still no tour asserts it**: tours start from a clean browser context, so the state needs either a wall-clock hour or a forged stored session — a unit concern, which is why the pin lives in Vitest. |
| 2 | environment (resolved) | Tokens appeared to carry `iat` ~7.6 h in the future. The owner confirmed the machine clock was wrong by that amount; there is no Supabase-side skew. Retained so the numbers in the diagnosis above make sense to a later reader. | Resolved by the owner; nothing to do in code. |
| 3 | surprise | `Enviar` stays enabled with an empty composer. The send is correctly refused client-side, so no scenario is violated; a disabled control would state it earlier. | Recorded; not pinned, since the spec asks for rejection and rejection is what happens. |
| 4 | none (defect) | Nothing else. Search, tag apply, tag filter, queueing and the Nova conversa cancel all behaved exactly as specified. | — |

## Transcribed to

`apps/e2e/test/tours/conversas-inbox.tour.spec.ts` — all four tours, from the
succeeded steps above. Step 10's filter assertion is transcribed as "strictly
fewer than the unfiltered count, and the remaining one is the tagged thread"
rather than as the literal 31, so it cannot pass vacuously against an inbox that
happens to hold one thread. Finding 1 is deliberately **not** transcribed.

---

## Re-run 2026-09-11 — real ports, by session local_ccd08bdb

The nine tours of the retroactive batch had only ever been driven on a private
stack (3101 / 5175 / 18082) because an orphaned API held port 3100. This re-run
put all 11 tour files on the real ports (3100 / 5174 / 18081). First result:
**42 passed, 1 failed** — then a second, different failure in this same file
once the first was fixed. Both were defects in the fixtures, not in the product.
Final: **43 passed, exit 0**, twice, the second time with `pnpm dev` holding
3000/5173 (dev PIDs unchanged before and after).

### Finding 4 — the origin chip was never pinned, so the scenario was unreachable

**Step 2 failed.** The row read `Anúncio` where this report recorded
`Desconhecida` on 2026-09-10.

Diagnosis, in the order it was established:

1. The spec (`conversas` — "List shows origin without inventing orgânica") is
   explicit: `AD` renders anúncio, `ORGANIC` orgânica, `UNKNOWN` desconhecida.
2. The database said `e2e-conv-tour.source_type = 'AD'`. So the screen was
   **right** — anúncio is the correct rendering of `AD`. No product defect.
3. `seed-e2e.ts` never set `sourceType`, leaving it at the schema default
   `UNKNOWN`.
4. `packages/db/prisma/seed/demo.ts` classifies conversations round-robin and
   scopes that sweep to rows **still `UNKNOWN`** — precisely what these rows
   were. Several `.live.test.ts` files shell out to `db:seed`, so a full
   `pnpm test` silently reclassified the fixture.

So the tour's oracle was right and its **precondition was never established**.
It went green on a fresh fixture and red after any full test run — a test whose
result depended on what else had touched the database that day.

**Fixed in the fixture, not the assertion:** `seed-e2e.ts` now pins `sourceType`
per conversation on **create and update** (the update branch matters — without
it the e2e seed would not undo the sweep). The tour row is `UNKNOWN` so the
scenario it claims to walk is actually reachable; the other four keep the values
the sweep had been giving them, so the origin mix Relatórios aggregates does not
shift.

**Verified by reproducing the hostile state:** ran `pnpm --filter @select-lub/db
db:seed`, confirmed the row read `AD`, then ran the tours and confirmed it read
`UNKNOWN` again and the step passed.

### Finding 5 — a row count read before the rows existed

**"Tour em Período Chuvoso: Nova conversa abandoned leaves no thread" failed:**
expected 0 rows, received 31.

`before` was captured immediately after `inbox().waitFor()`. That waits for the
list **panel**, which exists before its rows arrive, so `before` was 0; the
closing assertion then compared the loaded list of 31 against that 0. A race in
the test, not a product defect — and the tag-filter tour eleven lines earlier in
this same file already carried the guard, with a comment naming this exact
hazard.

**Fixed** by adding that same `await expect(listItems().first()).toBeVisible()`
before the capture. The other seven `.count()` captures across the tour files
were audited: all already wait on something first.

### Note on the tooling caveat in Finding 3

This re-run used the Playwright MCP, not the Browser pane, so the coordinate
trap recorded in Finding 3 did not apply. It stands as written for anyone who
falls back to the pane.
