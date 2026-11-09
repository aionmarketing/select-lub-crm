# Tour run — Assistive-prefill ghost (accept and dismiss)

## Feature

The prefill ghost in the contact rail: a suggested cadastro value offered beside
the field it would fill, with a control to accept it and a control to refuse it.
Accepting writes the value onto the customer; refusing writes nothing. Both
consume the suggestion.

Change under tour: `close-stated-coverage-gaps`, task 2.1. Commit: `647937b`
plus the task 1.1 fixture-shape correction made during this drive.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174`, mock Evolution `127.0.0.1:18081` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`, `OPENAI_API_KEY` and `GLM_API_KEY` blanked along with the plate and Omie credentials |
| Worker | not started |
| Database | per-worktree local Postgres |
| Seed | task 1.1: two ghosts, `e2e-conv-prefill-accept` and `e2e-conv-prefill-dismiss`, each on its own customer with a null name |

The language-model keys being blank is the point rather than a caveat. The ghost
is seeded as the PRODUCT of an extraction, so the tour walks accept and dismiss
without any model being reachable.

## Tours

- **Guiado (Negócio)** — the attendant's path: read the suggestion, take it, see
  it land on the customer.
- **Rumo Errado (Negócio)** — the same ghost refused instead of taken. The
  interesting half is what must NOT happen: refusing must write nothing.
- **Correios (Negócio)** — with both model keys blank, does a screen carrying a
  suggestion try to reach a model to render it?

## Guidebook

- `openspec/specs/assistive-prefill/spec.md` — accepting a suggested field
  writes it to the cadastro; refusing a suggestion discards it without writing;
  a consumed suggestion is no longer offered.

## Steps

### Tour Guiado — accept

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open `http://127.0.0.1:5174` | Auto-login landed on Conversas. One console error, a `favicon.ico` 404 | conversas — inbox is reachable | succeeded |
| 2 | Open the conversation for `11999000006` | Rail showed `Contato` with the phone as the heading AND as the subtitle — the customer has no name | assistive-prefill — a suggestion is offered beside the field it fills | succeeded |
| 3 | Read the ghost | `Marina Duarte`, labelled `sugestão`, with two controls: `Aceitar Nome` (✓) and `Recusar Nome` (×) | assistive-prefill — a suggestion is offered with accept and refuse | succeeded |
| 4 | Activate `Aceitar Nome` | The name appeared in THREE places at once: the inbox row, the thread header, and the `Contato` rail | assistive-prefill — accepting writes the value to the cadastro | succeeded |
| 5 | Look for the ghost again | No `sugestão` anywhere on the screen | assistive-prefill — a consumed suggestion is no longer offered | succeeded |

### Tour do Rumo Errado — dismiss

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 6 | Open the conversation for `11999000007` | Same ghost, same two controls, on a different customer | assistive-prefill — a suggestion is offered beside the field it fills | succeeded |
| 7 | Activate `Recusar Nome` | Ghost gone | assistive-prefill — refusing discards the suggestion | succeeded |
| 8 | Read both customers from the database | `e2e-cust-prefill-accept` name `"Marina Duarte"`; `e2e-cust-prefill-dismiss` name `null` | assistive-prefill — refusing writes nothing to the cadastro | succeeded |

### Tour dos Correios — nothing reaches a model

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 9 | Grep the API process output for the whole drive | 0 lines naming Motul, Tecfil or APIBrasil; 277 `prefill` requests, all served locally | assistive-prefill — a stored suggestion is rendered from storage | succeeded |

## Diagnosis

**The first drive failed, and the failure was mine.** Opening the accept
conversation returned HTTP 500 three times, `unrecognized_keys: "givenName",
"familyName"` at `fields`. The fixture was written from the shape
`packages/db/prisma/seed/demo.ts` uses, `{ givenName: { value, confidence } }`,
and that shape is wrong in two ways at once: the keys are not in
`prefillFieldKeySchema` (`name`, `taxId`, `plate`, `make`, `model`, `version`,
`year`, `odometerKm`), and the values are plain strings and numbers with no
confidence wrapper. `prefillFieldsSchema` is `.strict()`, and `mapPrefillView`
passes stored `fields` into the response DTO with no transform, so a wrong shape
is a 500 at serialization rather than a validation error the screen could show.

**This is the third serialization-boundary failure recorded today**, after the
empty `classification` in the quote path (PR #86) and its blast radius across
the demo fleet. The family is worth naming: valid-looking data reaches a
response schema that rejects it, the handler has already succeeded, and NO
test of the handler can see it. A screen shows a 500 where the data was fine
and the contract was the thing out of step.

Corrected to `{ name: "Marina Duarte" }` and re-seeded; the second drive is the
one recorded above. 60 of the 500s in the captured output belong to that first
window — the rail polls `prefill` continuously, so one bad row produces many —
and **0 occurred after the correction**, verified by counting 500s after the
accept POST.

**The same defect exists in the demo seed, and it was confirmed rather than
assumed:** `GET /conversations/e2e-conv-send/prefill` returns HTTP 500 against
this stack. The demo seed also attached that suggestion to an E2E fixture's
conversation, which is a second problem in the same row. Reported, not fixed
here: `packages/db` is outside this change's lane. See finding 2.

**Why `name` alone.** Accepting a vehicle-shaped field (`plate`, `make`,
`model`) writes a vehicle, which would need a vehicle fixture before the accept
means anything. `name` on a customer seeded with a null name makes both halves
observable with no extra fixture: accept is the name appearing, refuse is the
name staying null.

**The suggestion row SURVIVES both actions with `fields: {}`.** Neither accept
nor refuse deletes it; `stripPrefillField` removes the key and leaves the row.
This is the measured justification for the seed enforcing `fields` on the
upsert's UPDATE branch as well as CREATE: without it the ghost would exist on
the first run of the suite and be gone on every run after, since the row is
still there and only `create` would have been skipped. That was reasoned when
the fixture was written; this drive measured it.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | fixture defect — fixed | The seeded suggestion used `{ givenName: { value, confidence } }`, which `prefillFieldsSchema.strict()` rejects, producing HTTP 500 rather than a visible error. | Fixed in `seed-e2e.ts` during this drive, with the contract written into the fixture comment so the next person does not copy the demo shape. |
| 2 | defect — NOT fixed, outside lane, MEASURED | `packages/db/prisma/seed/demo.ts` seeds its prefill suggestion with the same `{ givenName: { value, confidence } }` shape, and `GET /conversations/e2e-conv-send/prefill` returns **HTTP 500** against the running stack. Not inferred — requested directly. Two distinct problems in one row: the shape is invalid, AND the demo seed attached it to `e2e-conv-send`, a conversation the E2E FIXTURES own. So a `packages/db` seed is writing onto an `apps/e2e` fixture's conversation. `conversas-send-text.spec.ts` passes because it never opens the prefill rail, but any tour that opens that conversation's rail hits the 500. | Reported to the orchestrator for placement; `packages/db` is outside this change's lane. The ownership collision is arguably the more serious half and may want its own fix. |
| 3 | surprise — recorded only | 277 `prefill` requests across a short drive on an idle screen. Matches the 340-request observation in `2026-09-10-conversas-cadastro.md`; no scenario forbids it and nothing failed. | Recorded here and there. Still unexplained. |

## Transcription (task 3.1)

Both tours failed twice before passing, and **neither failure was in the drive**
— both were in the spec's reading of the API, which the drive never had to do
because the screen did it. That is the fourth time a transcribed tour has failed
a step its live drive walked without trouble.

1. `GET /customers/:id` **does not exist**; only PATCH does. The rail reads the
   cadastro through `GET /conversations/:id/customer`, so the spec now does too
   — which has the side benefit of asserting on exactly what the screen is
   served.
2. That response nests the customer: `{ customer, pendings }`. Reading `name` at
   the top level gives `undefined`, and `expect(undefined).toBeNull()` fails.
   Worth keeping distinct: an unset name here is genuinely `null`, so `undefined`
   and `null` must not be conflated in an assertion whose whole point is that
   nothing was written.

Both runs of the file then passed, run twice in a row per task 3.5. The second
run is the one that matters: the accept tour CONSUMES its suggestion, so a
fixture that set `fields` only on the upsert's `create` branch would have made
run two red. It was green.

## Transcribed to

`conversas-cadastro.tour.spec.ts` — ghost accept and ghost dismiss, task 3.1.
Only the steps marked succeeded above, and each `expect` cites the
`assistive-prefill` scenario named in its row rather than a value this drive
displayed.
