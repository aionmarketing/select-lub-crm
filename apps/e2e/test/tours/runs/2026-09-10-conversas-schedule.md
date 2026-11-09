# Tour run — Programar mensagem (Conversas)

## Feature

Programar mensagem on the Conversas contact rail: the schedule dialog for a
service, its occupied-service block, and the cancel path.

Change under tour: `exploratory-tour-tests` (worked example, design D9).
Commit: `4efce05` plus the uncommitted tour harness of tasks 1.1–1.6.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | Claude Code Browser pane (D13 fallback) |
| Why not Playwright MCP | Server configured at user scope and healthy (`claude mcp get playwright` → Connected, Chromium 1243 installed), but MCP tools attach at session start and this session began before it was added |
| Tour stack | API `127.0.0.1:3100`, SPA `127.0.0.1:5174`, mock Evolution `127.0.0.1:18081` |
| Provider guard | `OMIE_MOCK=1`, `PLACAS_MOCK=1`; `OPENAI_API_KEY`, `GLM_API_KEY`, `PLACAS_TOKEN`, `OMIE_APP_KEY`, `OMIE_APP_SECRET` blanked |
| Worker | not started |
| Database | per-worktree local Postgres on 5433 |
| Seed | `seedE2eFixtures()` via the tours config `globalSetup` |

## Tours

| Tour | District | Why this one for this feature |
| --- | --- | --- |
| Guiado | Negócio | The guidebook walk. This feature's whole value is that confirming schedules without sending, and nobody had driven that end to end in a browser. |
| Rumo Errado | Decadente | The dialog has a blocked state (occupied service). Legal actions in an illegal order is exactly how a blocked state leaks. |
| Obsessivo-Compulsivo | Decadente | Confirm writes a row. Repeating the open/close approach before confirming is how a duplicate row would appear. |
| Período Chuvoso | Hoteleiro | The form is long enough to abandon halfway. Escape mid-form must leave no partial schedule. |

## Guidebook

Scenarios walked, from `openspec/specs/repo-foundation/spec.md` (Requirement:
Critical attendant flows have Playwright coverage):

- Programar mensagem confirm does not send now
- Occupied service blocks confirm and still allows cancel

## Steps

### Tour Guiado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Load `/` on the tour SPA | Auto-login completed with no login form; inbox listed demo threads plus the four e2e fixtures | repo-foundation — Auto-login lands on the Conversas inbox | succeeded |
| 2 | Open `?conversation=e2e-conv-schedule` | Thread rendered; rail showed both seeded services, `conversas-programar-free` on `e2e-svc-free` and `conversas-programar-occupied` on `e2e-svc-occupied` | seed fixture shape (`test/seed-e2e.ts`) | succeeded |
| 3 | Activate Programar mensagem on the free service | Dialog opened: heading, prefill note naming the service, `Cliente: E2E Agenda`, `Data sugerida: 09/03/2027`, separate Data and Hora fields, `Fuso America/Sao_Paulo` | repo-foundation — confirm does not send now (precondition) | succeeded |
| 4 | Read dialog state before typing | Message empty; Confirmar `disabled`; Data `2027-03-09`; Hora `00:00` | scheduled-messages — a schedule needs a text | succeeded |
| 5 | Type `Tour Guiado retorno combinado`, activate Confirmar | No "já enviado" copy anywhere on the screen | repo-foundation — composer does not show the text as already sent on WhatsApp | succeeded |
| 6 | Read `GET /conversations/e2e-conv-schedule/scheduled-messages` | One row `serviceId=e2e-svc-free`, `status=SCHEDULED`, text as typed, `scheduledAt=2027-03-09T03:00:00.000Z` (= 00:00 São Paulo, UTC−3) | repo-foundation — a ScheduledMessage exists for that service | succeeded |
| 7 | Re-read the rail's Programar controls | `e2e-svc-free` now renders `conversas-programar-occupied` | scheduled-messages — one non-cancelled schedule per service | succeeded |
| 8 | Activate Programar mensagem on `e2e-svc-occupied` | Dialog opened and stayed open, showed `Este serviço já tem uma mensagem programada.`, Confirmar `disabled`, Fechar present | repo-foundation — occupied service blocks confirm and still allows cancel | succeeded |

### Tour em Período Chuvoso

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 9 | Cancel the step-5 schedule through `POST …/cancel`, reload | Status `CANCELLED`; the service rendered `conversas-programar-free` again | scheduled-messages — cancel before send frees the service | succeeded |
| 10 | Open the dialog, type `Periodo Chuvoso abandonado`, press Escape | Dialog closed | Período Chuvoso — cancel mid-operation | succeeded |
| 11 | Re-read schedules, composer, and rail | No new row (only the occupied fixture and the cancelled one); composer present and empty; service still `conversas-programar-free` | repo-foundation — state restored after a cancel, no partial write | succeeded |

### Tour Obsessivo-Compulsivo

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 12 | Open and Escape the dialog five times, then type `Obsessivo Compulsivo uma vez` and confirm once | Dialog survived every cycle and opened again each time | Obsessivo-Compulsivo — repetition must not accumulate state | succeeded |
| 13 | Count `SCHEDULED` rows on `e2e-svc-free` | Exactly one, text as typed | scheduled-messages — one non-cancelled schedule per service | succeeded |

### Tour do Rumo Errado

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 14 | Open the dialog on the occupied service and activate the disabled Confirmar three times | Nothing happened; no request left the page | repo-foundation — Confirmar is unavailable on an occupied service | succeeded |
| 15 | With the dialog open, click another conversation row in the inbox | The modal backdrop absorbed the click and closed the dialog; the inbox selection did not change (`?conversation=e2e-conv-schedule` still) | Rumo Errado — an illegal order is refused rather than half-applied | succeeded |
| 16 | Re-read both conversations' schedules and the main pane | No orphan row on either conversation; no new row on the toured one; main pane still had content | repo-foundation — no blank pane, no partial write | succeeded |

## Diagnosis

**Two console 400s were mine, not the app's.** `POST …/cancel` returned
`FST_ERR_CTP_EMPTY_JSON_BODY` twice because the drive sent
`Content-Type: application/json` with no body. Fastify is right to refuse it.
Re-sent without the header, the cancel returned 200. Nothing to fix.

**No app-originated console error, no uncaught page error, and no HTTP 5xx** in
334 recorded `/api` requests across the drive.

**The dialog closes on Confirmar.** `test/conversas-schedule.spec.ts` asserts
`getByRole("dialog", …)` is still visible right after confirming. That spec is
green, so it is asserting during the MUI close transition while the node is
still mounted. The assertion is not wrong today, but it pins a transient frame
rather than a behaviour, so it would flip on any change to the transition. Worth
a follow-up; not a defect and not in this change's scope.

**Step 15 could not exercise what it set out to.** The intent was "switch
conversations while the form is open". The dialog is modal, so the backdrop eats
the click and the switch never reaches the list. That is the answer to the Rumo
Errado question — the illegal order is structurally prevented — but it means the
tour never reached a mid-form navigation. Reaching it needs keyboard navigation
or a direct URL change, and that is a candidate step for the next drive.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | none (defect) | No defect found in Programar mensagem. Both guidebook scenarios behaved exactly as specified, including the São Paulo offset on the stored `scheduledAt`. | — |
| 2 | surprise | `conversas-schedule.spec.ts` asserts a dialog that is mid-close. Green today, brittle to a transition change. | Not a defect, so nothing to pin. Raised as follow-up task `task_ab8b7e92` ("Fix brittle dialog assertion in conversas-schedule spec"), out of this change's scope. |
| 3 | tooling | Under viewport emulation the Browser pane resolves a `ref` click to page-space coordinates while the pane expects screenshot-frame coordinates, so ref clicks land roughly 1.8× off and silently hit the wrong element. Clicking by explicit screenshot-frame coordinates works every time. | Recorded in `skills/testing-exploratory-tours` as the fallback's caveat; the reason D13 prefers the Playwright MCP. |

## Transcribed to

`apps/e2e/test/tours/conversas-schedule.tour.spec.ts` — all four tours, from the
succeeded steps above. Steps 6, 9 and 13's API reads become `crmApi` assertions;
step 15 is transcribed as the backdrop-closes-the-dialog behaviour that was
actually observed, not as the mid-form navigation that was intended.
