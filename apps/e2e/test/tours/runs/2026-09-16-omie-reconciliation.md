# Tour run — Omie reconciliation pendings (the panel, and resolving one field)

## Feature

The `Pendências com o Omie` panel opened from the inbox header: every open
conflict across all customers, each showing what the CRM holds against what Omie
holds, with a per-field choice. Resolving one field writes the chosen side and
leaves every other field alone.

Change under tour: `close-stated-coverage-gaps`, task 2.4. Commit: `2121281`.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174`, mock Evolution `127.0.0.1:18081` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, `OMIE_APP_KEY` and `OMIE_APP_SECRET` blanked with the rest |
| Worker | not started |
| Database | per-worktree local Postgres |
| Seed | task 1.3: `E2E Conciliação`, linked, holding TWO open pendings — `city` and `postalCode` |

No real ERP credential was present, and the Omie adapter is the mock. A
reconciliation pending is a stored disagreement, so the panel reads rows rather
than calling Omie to render them.

## Tours

- **Guiado (Negócio)** — the attendant's path: open the panel, read one
  conflict, choose a side, watch the work shrink.
- **Colecionador (Turístico)** — count everything. The header count and the
  panel's headline are of FIELDS, not customers, and only a fixture with two
  conflicts on one customer can tell those readings apart.
- **Rumo Errado (Negócio)** — resolve ONE field and check the others. The panel
  says "Resolva campo a campo"; the interesting question is whether the code
  agrees.

## Guidebook

- `openspec/specs/omie-sync/spec.md` — Shared fields follow the four-cell
  conflict policy (dual change opens a pending); Resolved pendings are retained
  history; HTTP apply and list pendings (`GET /customers/:id/reconciliation-pendings`
  returns `open` rows).

## Steps

### Tour Guiado and Colecionador — read the work

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open the inbox | Header control read `Pendências com o Omie, 4`. It had read `2` before this change's fixture — the two seeded conflicts moved it by two | omie-sync — open pendings are listed for the unit | succeeded |
| 2 | Open the panel | Headline `4 campos ainda sem resolução`, across **three** customer groups: `Helena Costa` (1), `E2E Conciliação` (2), `Gael Pereira` (1) | omie-sync — pendings are grouped per customer | succeeded |
| 3 | Read the fixture's group | Two rows. `Cidade`: CRM `Niterói`, Omie `Petrópolis`. `CEP`: CRM `24020000`, Omie `25680000`. Each with `Usar CRM`, `Usar Omie`, `Editar valor` | omie-sync — a pending carries both sides for one field | succeeded |
| 4 | Read the panel's footer | `O sistema não escolhe um lado automaticamente. Resolva campo a campo.` | omie-sync — the four-cell policy is per-field, not all-or-nothing | succeeded |

**4 fields across 3 customers is the whole point of step 2.** A count of
customers would have read `3` and a count of one customer's fields would have
read `2`. Only the field count reads `4`, so this observation distinguishes the
readings that a single-conflict fixture cannot.

### Tour do Rumo Errado — resolve one field, check the rest

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 5 | Activate `Usar Omie` on `Cidade` only | Headline fell to `3 campos ainda sem resolução` | omie-sync — resolving closes that pending | succeeded |
| 6 | Read the customer back from the database | `city` is now `Petrópolis` — the Omie side, the one chosen | omie-sync — the chosen side is applied to the CRM record | succeeded |
| 7 | Read the OTHER field | `postalCode` pending still `open`, and the column still `null`. Choosing a side for one field wrote nothing for the other | omie-sync — resolve is per-field, not all-or-nothing | succeeded |
| 8 | Read the resolved row | Still present, `status` `resolved`, both values intact — not deleted | omie-sync — "Resolved pendings are retained history" | succeeded |
| 9 | Read every other customer's pendings | `demo-cust-02` `taxId` still open; `demo-cust-01-veh` `plate` still open. The fixture's resolve reached no other customer | omie-sync — resolve applies to the named customer and field | succeeded |

## Diagnosis

**Step 7 is the half that could have been skipped, and it is the one worth
having.** A tour that resolved a field and asserted only that the count dropped
would pass identically against a bug that closed every pending on that customer,
or every pending in the unit. The panel states "Resolva campo a campo" as a
promise to the attendant; step 7 is what checks the code keeps it, and step 9
extends the same question outward to other customers.

**The count is of fields, and the fixture was built to prove it.** This is why
task 1.3 seeds two conflicts on one customer rather than one: with a single
pending, `1 campo` and `1 cliente` are the same number and the tour cannot tell
which the panel means.

**Nothing reached Omie.** A pending is a stored disagreement between two
snapshots, so rendering the panel and resolving a row are database operations;
the adapter is the mock and both ERP credentials are blank. The tour asserts
this rather than assuming it.

**No defect found.** The panel does what its footer promises.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | confirmation, not a defect | Resolving one field leaves the customer's other pending open AND unwritten, and leaves other customers untouched. Measured on both sides rather than inferred from the count. | Pinned by the tour transcribed below. |
| 3 | fixture defect — fixed | The seed rewrote the pendings but not the customer's conflicting COLUMNS, so a second run started with the Omie value already stored and the tour's central assertion would have passed vacuously. Caught by the tour's own precondition on its first run. | Fixed in `seed-e2e.ts`; the untouched-field assertion got stronger as a result. |
| 2 | note | The header count and the panel headline are of FIELDS across all customers, not of customers. Easy to misread as a customer count, and a single-conflict fixture cannot distinguish them. | Recorded in the fixture comment and in this report; the tour pins the field reading. |

## Transcription (task 3.4)

The tour failed on its FIRST run, at its own precondition, and the failure was a
real fixture defect rather than a flake:

```
expect(storedCity()).not.toBe("Petrópolis")
```

The drive above had resolved `city` to the Omie side, and the seed rewrote the
pendings but **not the customer's columns**. So the second run started with
`city` already holding the Omie value, and the tour's central assertion — that
resolving applies the chosen side — would have passed against a row that already
held it. Vacuous, and it would have stayed vacuous forever.

The seed now sets `city` and `postalCode` to the CRM side on every run. **Third
instance of the same omission in this file**, after `sourceType` and the prefill
ghost's `fields`: declaring a field is not enough; it has to be enforced on
every run rather than only the first.

Two things are worth keeping from this. The precondition assertion is what
caught it — a tour that had simply resolved and checked the result would have
gone green and meant nothing. And the fix made the tour STRONGER than planned:
the untouched field's assertion is now `postalCode` still holding its CRM value,
which is a real negative, where before it was merely `null`.

Both runs then passed, run twice in a row per task 3.5.

## Transcribed to

`conversas-omie.tour.spec.ts` — task 3.4. Only the steps marked succeeded, and
each `expect` cites the `omie-sync` scenario named in its row.
