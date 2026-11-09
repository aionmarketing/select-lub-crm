# Tour run — Configurações (tag and template catalogs)

## Feature

The two per-unit catalogs on `/configuracoes`: creating a tag and a template,
what happens on a blank or duplicate submit, deactivating an entry, and whether
a catalog change reaches the screens that consume it.

Change under tour: `exploratory-tour-tests`, task 5.9 (retroactive coverage).
Commit: `4efce05` plus the uncommitted tour harness, the task 5.1/5.2 page
objects and seed extension, and the task 5.7 archive fix.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| Why not 3100/5174 | Port 3100 held all session by an orphaned tour API. Same guards on private ports; see `2026-09-10-app-shell.md`. |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, paid-provider credentials blanked |
| Worker | not started |
| Database | per-worktree local Postgres on 5433 |
| Seed | task 5.2 extension: the unit starts with one tag (`E2E Turista Tag`) and one template (`E2E Retorno`) |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | Create a tag, create a template, see them listed. The catalog's entire purpose. |
| Ator Coadjuvante | Entretenimento | A catalog is only worth having because *other* screens read it. This tour follows a tag out of Configurações and into the Conversas inbox filter, and then watches it leave again when deactivated. |
| Rumo Errado | Decadente | Submit nothing; submit a name that already exists. Both are things an attendant does, and both must be refused without damage. |
| Período Chuvoso | Hoteleiro | Deactivation is this screen's soft delete. An entry must leave the consumers without leaving the catalog, so it can come back. |

Left out: Colecionador (two catalogs of the same shape, not several distinct
outputs), Museu, and template preview interpolation — it has no control on this
screen and is covered by API tests.

## Guidebook

From `openspec/specs/tags-templates/spec.md`:

- Attendant opens Configurações
- A catalog is one card under its heading
- Create then list
- Duplicate active name is rejected
- Duplicate active template name is rejected
- Deactivate hides from apply options

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `/configuracoes` | Two named regions, `Tags` and `Templates`, each a card holding its create form above its list, with the seeded entries listed and `Editar` / `Desativar` on each row | tags-templates — Attendant opens Configurações; A catalog is one card under its heading | succeeded |
| 2 | Type `Tour Config Tag`, activate `Criar tag` | The tag appeared in the list immediately; the catalog went from one entry to two | tags-templates — Create then list | succeeded |
| 3 | Type `Tour Config Template` with body `Olá {{nome_cliente}}, tudo bem?`, activate `Criar template` | The template appeared in the list with its body rendered beside the name | tags-templates — Create then list | succeeded |

### Tour do Ator Coadjuvante

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 4 | Open `/` and read the inbox filter chips | `Tour Config Tag` was offered as a filter chip alongside the seeded `E2E Turista Tag` | tags-templates — the catalog feeds the inbox filter | succeeded |

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Back on `/configuracoes`, activate `Desativar` on `Tour Config Tag` | The row stayed in the catalog, now marked `Inativa`, and its control changed from `Desativar` to `Reativar` — a soft delete, reversible | tags-templates — Deactivate hides from apply options (catalog side) | succeeded |
| 6 | Open `/` again and re-read the filter chips | `Tour Config Tag` was **gone** from the chips, while the still-active `E2E Turista Tag` remained | tags-templates — Deactivate hides from apply options (consumer side) | succeeded |

Steps 4 and 6 are the pair that matters: the same chip present, then absent,
with an active sibling that stays put throughout. Either step alone would be
consistent with a filter that simply lists nothing.

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 7 | Activate `Criar tag` with the name field empty | Nothing was created — the catalog was unchanged — and **no message was shown** | tags-templates — a nameless tag is not created | succeeded (with finding 1) |
| 8 | Type the existing name `E2E Turista Tag` and activate `Criar tag` | The API answered **409 Conflict**, nothing was created, the name field cleared — and again **no message was shown**; the only trace was a console error | tags-templates — Duplicate active name is rejected | succeeded (with finding 1) |

## Diagnosis

**Both refusals are silent.** Steps 7 and 8 do the right thing to the data — no
tag is created either way, and the duplicate is correctly refused with 409 by
the API — but the screen tells the attendant nothing. The field simply empties.
From the attendant's seat, a duplicate submit and a successful submit look
almost the same: something happens, the field clears, and only counting the list
reveals which. The `tags-templates` scenarios specify the *rejection*, and the
rejection happens, so this is not a scenario violation — but it is the kind of
thing a person notices in ten seconds and a spec never mentions. Recorded as
finding 1.

**Row controls are not individually named.** Both `Editar` and `Desativar`
render with identical accessible names on every row, so nothing distinguishes
one row's control from another's except position. The tour scopes to the row
that contains the entry's name, the same shape used for vehicle rows in
`2026-09-10-conversas-cadastro.md`. Not a defect, but the second screen in this
batch where per-row controls need positional or structural scoping.

**Created entries persist across runs.** The tour creates a tag and a template
each time, and the seed did not remove them, so a re-run would find its own
leftovers and the duplicate-name step would start passing for the wrong reason.
Fixed in `seed-e2e.ts` with a sweep scoped to the `Tour Config` name prefix —
narrow on purpose, so a catalog entry a person made by hand is never touched.

**No 5xx.** The only console error across the drive was the expected 409.

**The tour harness needed a small extension, and it was right to.** The
transcribed Rumo Errado tour failed its first run on the `tourLog` invariant:
the browser logs every non-2xx fetch as a console error, so the 409 the tour
deliberately provokes read as a defect. Adding `409` to the module-level
allow-list would have been the wrong fix — it would blind every *other* tour to
an unexpected conflict. Instead `tourLog` now takes a per-test declaration,
`tourLog.expect(/…409/)`, so a refusal is tolerated only in the one tour that
went looking for it. This is the first tour in the batch to provoke a refusal on
purpose, which is why the gap only surfaced now.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | surprise (usability) | Blank submit and duplicate submit are both refused **silently**. No inline error, no toast, no `role="alert"` anywhere — the name field just clears, which is also what a successful create does. The data is never wrong; the attendant is just never told. | Not a scenario violation — `tags-templates` specifies that the duplicate is rejected, and it is — so nothing is pinned and no production code changed. Raised for the spec owner in this change's findings roll-up, since deciding what the screen should say is a spec decision. |
| 2 | tooling (mine) | Tour-created catalog entries accumulated across runs and would have made the duplicate-name step pass for the wrong reason. | Fixed in `seed-e2e.ts` via the `TOUR_CREATED_PREFIX` sweep; verified by re-seeding. |
| 3 | none (defect) | Nothing else. Create, list, deactivate, the reversibility of deactivation, and its propagation to the inbox filter all behaved as specified. | — |

## Transcribed to

`apps/e2e/test/tours/configuracoes.tour.spec.ts` — all four tours, from the
succeeded steps above. Steps 7 and 8 are transcribed as **what the app actually
does** — the catalog is unchanged and no entry is added — rather than as the
error message a person might expect, because asserting a message that does not
exist would fail, and asserting its absence would pin finding 1 as intended
behaviour. The count comparisons are before/after deltas, never literals.
