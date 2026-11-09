# Findings roll-up — retroactive tour coverage (change `exploratory-tour-tests`, tasks 5.3–5.11)

Nine areas were explored live through the Playwright MCP on 2026-09-10 and
transcribed into eleven tour files. This is the triage required by task 5.13:
every finding across those drives, what kind it is, and where it went. Each row
either names a fix and its pin, names the durable `it.skip` that holds it open,
or says why nothing is owed.

The per-area detail lives in the run reports beside this file; this page exists
so a reviewer can see the whole harvest without opening nine of them.

## Real defects

| # | Defect | Found by | Disposition |
| --- | --- | --- | --- |
| D1 | **`Arquivar este retorno` and `unarchive` never worked.** `send()` in `apps/web/src/api/returnReminders.ts` declared `content-type: application/json` on a bodyless POST; Fastify refuses that with `FST_ERR_CTP_EMPTY_JSON_BODY` (400) before the route runs. Proven not-a-fixture: the same endpoint answered 200 for the same token with the header omitted. | `follow-up.tour.spec.ts` (`runs/2026-09-10-follow-up.md`, finding 1) | **Fixed** in `apps/web/src/api/returnReminders.ts` — the content-type is set only when there is a body, matching `cancelScheduledMessage` in `./scheduled.ts`. **Pinned** by `apps/web/src/api/returnReminders.test.ts`, mutation-checked: 2 of its 3 cases go red on the old code, and the third (a write that *does* carry a body) stays green so the fix cannot over-reach. Re-driven live afterwards; the Follow-up tour now asserts the corrected behaviour. |
| D2 | **The SPA never recovers from a refused session.** After ~1 h — the access-token lifetime — every CRM call answers 401, counts render `—`, and React Query retries without bound (6 → 188 console errors in ~3 min idling). A reload does not help: `hydrateMvpSession` (`apps/web/src/AppProviders.tsx:104`) takes any stored session on trust and returns before its password-grant fallback, so the dead token is re-applied every time. Only clearing `sb-*-auth-token` recovers. Observed twice, an hour apart. | `conversas-inbox.tour.spec.ts` and `follow-up.tour.spec.ts` (`runs/2026-09-10-conversas-inbox.md` finding 1, `runs/2026-09-10-follow-up.md` finding 2) | **Fixed** by change `session-recovery` (`openspec/changes/session-recovery/`), which specified it first — the `auth` spec had no scenario saying what should happen, so a fix would have been inventing the requirement inside a testing change. The fix has three parts: an `onAuthStateChange` subscription so a background-refreshed token is the one sent; `recoverSession()`, which treats a 401 as a refused session, clears the client's storage and re-grants, reached from hydration directly and from any mid-life 401 through a `sessionRecovery.ts` registry that keeps the HTTP layer free of auth policy; and a `retryUnlessRefused` query policy, since the unbounded retry is what made a dead session a 401 storm rather than a stale screen. **Pinned** by twelve non-mounting cases in `apps/web/src/AppProviders.session-recovery.test.ts` plus four mounted ones in `AuthHydrate.test.tsx`. **Still asserted by no tour**, and correctly so: the state needs a wall-clock hour or a forged stored session, neither reachable from a clean browser context. |
| D3 | **The vehicle row's accessible name omits its visible plate.** The row renders `ABC1D23 ›` but carries `aria-label={\`Ver ${drillLabel}\`}` → `"Ver Volkswagen Gol 2019"`. An `aria-label` replaces the text for name computation, so a screen-reader user never hears the plate and a speech-input user cannot say it. WCAG 2.5.3 *Label in Name*. | `conversas-cadastro.tour.spec.ts` (`runs/2026-09-10-conversas-cadastro.md`, finding 4) | **Fixed 2026-09-12**, once the owner settled the wording question that was blocking it — by deciding there should be no wording at all. The `aria-label` is REMOVED from both variants rather than reworded, so the accessible name falls back to the row's visible text and the two can no longer drift apart. That is why this needed an owner: rewording would have invented a requirement no scenario states, whereas deleting the override just stops the component overriding what it already displays. The chevron stays `aria-hidden`. **Pinned** by `apps/web/src/conversas/vehicles.rail-row.a11y.test.tsx`, now six executing cases (both variants × name-contains-plate, no-control-named-without-the-plate, and a plate-less vehicle still having a non-empty name) — restoring the `aria-label` turns two of them red. Six assertions in `ConversasPage.veiculo.test.tsx` and `ConversasPage.prefill-switch.test.tsx` that located the row by `"Ver Toyota Corolla 2019"` now use the plate, which is what a person actually sees. |

No tour was edited to pass. D1's tour asserts the fixed behaviour only because
the defect was fixed, pinned and re-driven; D2 and D3 are asserted by no tour, and both have since been fixed and pinned in Vitest instead — which is the right level for each: D2 is only reachable after an hour of wall-clock, and D3 is an accessible-name computation that a component test can read directly and a tour cannot.

## Surprises and gaps (no defect owed)

| # | What | Found by | Why nothing is owed |
| --- | --- | --- | --- |
| S1 | Tag colour and template variables are validated **on read**, so one row outside the closed domain takes the whole list endpoint to 500 — blanking Configurações and the Relatórios tag filter. | app-shell drive (`runs/2026-09-10-app-shell.md`, finding 2) | The only writer is the API, which validates on write, so this is defence-in-depth rather than a live defect. Reachable only by writing a bad row directly, which is how I hit it. Spec-owner call. |
| S2 | Blank and duplicate submits in Configurações are refused **silently** — no inline error, no toast, no `role="alert"`; the field just clears, which is also what success looks like. | `configuracoes.tour.spec.ts` (`runs/2026-09-10-configuracoes.md`, finding 1) | `tags-templates` specifies the *rejection*, and the rejection happens. Sharpened by the Usuários drive: that screen **does** render `Não foi possível criar o usuário` on its 409, so the alert pattern exists and is simply unused here — a consistency gap, not a missing capability. |
| S3 | The Serviços detail's `Abrir conversa` and `Programar mensagem` are both hardcoded `to="/"`, dropping the customer. | `servicos.tour.spec.ts` (`runs/2026-09-10-servicos-usuarios.md`, finding 1) | Partly defensible: `conversas` enumerates exactly three entry points to the schedule form and calls a fourth a defect, so navigating away rather than opening the form is a reasonable reading. `Abrir conversa` has no such excuse. No scenario states the target, so pinning `to="/"` would freeze it. |
| S4 | The garbage-palette fallback does not heal the stored value; every boot re-does the fallback. | `app-shell.tour.spec.ts` (`runs/2026-09-10-app-shell.md`, finding 3) | `design-system` requires only that it falls back, which it does. |
| S5 | `GET /conversations/:id/prefill` was requested 340 times on an idle screen. | cadastro drive (`runs/2026-09-10-conversas-cadastro.md`, finding 5) | A refetch cadence; nothing failed and no scenario forbids it. Flagged in case it is unintentional. |
| S6 | The Relatórios clear control does not count the period, so narrowing only the dates offers no one-click way back. | `relatorios.tour.spec.ts` (`runs/2026-09-10-relatorios.md`, finding 2) | Consistent with the spec, which counts *set filters* against a period that always has a value. |
| G1 | **Assistive-prefill ghost accept and dismiss are untoured.** | `runs/2026-09-10-conversas-cadastro.md`, finding 3 | Needs a `CadastroPrefillSuggestion` from an AI extraction; the tour stack blanks `OPENAI_API_KEY` and `GLM_API_KEY` on purpose. In the coverage ledger. |
| G2 | **The oil quote's entire happy path is untoured** — cards, price editing, message assembly. | `runs/2026-09-10-conversas-oil-quote.md`, finding 2 | Needs `MotulCompatibility` and `CatalogItem` rows, i.e. seeding the catalog the guard exists to keep out. A decision about what the tour stack may contain, not something a tour settles. In the coverage ledger. |
| G3 | **Channel-down paths are untoured** — the seed forces `CONNECTED`. | coverage ledger (`whatsapp-channel` row) | Needs a fixture that flips the connection row. Named in the ledger. |

## Environment notes

| # | What | Resolution |
| --- | --- | --- |
| E1 | Tokens appeared to carry `iat` ~7.6 h in the future. | **Resolved by the owner**: the machine clock was wrong by that amount. There is no Supabase skew, and the token in D2 had simply expired. Retained because the numbers in the inbox report's diagnosis only make sense with it. |
| E2 | Port 3100 was held all session by an orphaned tour API (`tsx watch`, pid 10476, 06:34) that this session lacked permission to kill. Every tour was therefore explored and verified on a private guarded stack (API 3101, SPA 5175, mock Evolution 18082) with identical env guards. | Locators and behaviour are identical — same SPA build — so transcription is unaffected. `pnpm test:e2e:tours` on the real ports (task 6.3) still needs 3100 free. |
| E3 | The shared local database changed under the session from outside these tours: Serviços went from `34 serviços · R$ 13.200,00` to `7 · R$ 0,00`, Follow-up vencido from 17 to 1, and Usuários rows from `+2 fora do seu acesso` to `+39`. | **Cause: a concurrent re-seed of the shared database, not an outage.** Established 2026-09-11 with peer `local_db6074eb`, who also retracted an earlier Docker-outage theory I had briefly recorded here. Two facts settle it: (1) the symptom is wrong for an outage — Docker going down yields *connection refused*, and no drive in this batch ever saw one; the app kept answering, with **different data**. Data being replaced mid-session is the signature of a re-seed or a scrub. (2) `selectlub_active_sessions_pending_tasks_a7b368` is on port **5433**, which is the Docker Compose instance (5432 is an unrelated server that rejects this project's credentials), so the drives were never on a "native Postgres" — an inference I made and that was wrong. `a7b368` is a busy worktree database with several sessions on it, and a full suite run re-seeds it partway through. This is the already-documented pattern where identical full runs fail on different files while each file passes alone. **Nothing in this batch depends on the affected numbers**: every tour asserts deltas and shapes, never a row count, currency total or tally — which turns out to be the right design against concurrent re-seeding generally, not just against the drift observed here. |
| E4 | A peer reported an orphaned `pnpm dev:worker` draining outbox rows on `selectlub_cursor_redesign` while pointed at the **hosted** Evolution — i.e. test-generated rows could have gone out as real WhatsApp sends. | **Did not affect these tours.** This worktree's `.env` targets `selectlub_active_sessions_pending_tasks_a7b368`, a different database, so that worker never saw a tour-generated row. The worker has since died with the Docker Postgres. Retained as a standing hazard: `conversas-inbox.tour.spec.ts` asserts an outbox status of `queued` on the strength of "the tour stack starts no worker", so a live worker on the same database is the first thing to suspect if that assertion ever flakes to `claimed`. |

## Why a tour found D1 when nothing else had

Worth recording, because the evidence is in this folder rather than in anyone's
recollection. `runs/2026-09-10-conversas-schedule.md` — the worked example,
driven before any of this batch — hit the **exact same error** and correctly
dismissed it:

> **Two console 400s were mine, not the app's.** `POST …/cancel` returned
> `FST_ERR_CTP_EMPTY_JSON_BODY` twice because the drive sent
> `Content-Type: application/json` with no body. Fastify is right to refuse it.
> Re-sent without the header, the cancel returned 200. Nothing to fix.

That diagnosis was right about *its own request*. What it could not see is that
`apps/web/src/api/returnReminders.ts` was making the identical mistake on every
archive and unarchive, and had been for as long as the code existed. A second
observer — session `local_ccd08bdb` — reported hitting the same refusal on a
hand-written cancel call and also writing it off as their own error.

So the error was seen at least twice, understood both times, and correctly
dismissed both times, because in both cases the malformed request really was the
observer's own. It survived because nobody was **clicking the actual button**.
D1 was found by a tour that did exactly that, watched a real 400, and checked
whether the app or the drive had sent it.

No unit test would have surfaced it either: the client sent a request the server
refused, and neither side was individually wrong in a way its own tests could
notice. That is the case for tours, and it needs no corroboration beyond the two
run reports in this directory.

## Transcription lessons

Recorded because they cost real time and will recur.

- **Every spec failed its first run on a timing race the drive never saw.** Each
  MCP call is its own round trip, so the drive waits seconds where a spec waits
  milliseconds. All were fixed with auto-waiting, never with weaker assertions.
- **The palette check needed two fixes.** Waiting for "a colour different from
  before" is satisfied by a half-finished CSS transition — the full-suite run
  caught `rgb(149,121,55)`, a blend. It now waits for the colour to *settle*.
  The weaker fix passed the file in isolation twice; only the whole suite under
  load exposed it. **A tour that is only ever run alone is not verified.**
- **A locator bug can impersonate the defect you are hunting.** The oil-quote
  tour appeared to open the wrong vehicle's quote — exactly what it exists to
  catch — and it was `filter({ hasText })` matching an ancestor that contained
  both vehicles. Only the live drive's evidence said the app was right.
- **Driving a controlled MUI switch's hidden input lies.** Clicking the `input`
  flips the DOM checkbox with React's handler never running: `checked` reports a
  toggle that was never persisted. Click the label; verify through the API.
- **The tour fixture gained `tourLog.expect(pattern)`** so a Decadente tour can
  declare the refusal it provokes. Adding `409` to the module allow-list would
  have blinded every other tour to an unexpected conflict.
