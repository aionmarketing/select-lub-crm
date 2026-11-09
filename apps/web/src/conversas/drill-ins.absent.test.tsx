/**
 * Test design (testing-strategy)
 *
 * Scope: the ABSENT-VALUE fallbacks of `ServiceDrillIn` and
 * `ScheduledMessageDrillIn`. Both components are rendered directly inside
 * `AppProviders`; MSW answers their one GET each; query retry off.
 *
 * Why these cases exist: the scoped coverage run of 2026-09-07 put
 * `drill-ins.tsx` at 100% statements / 92.3% functions / 83.33% BRANCHES —
 * the shape of a file whose every function runs but whose fallbacks never
 * do. The eight uncovered branches (lines 60, 89, 111, 114, 116, 117, 134,
 * 267) are, without exception, the side taken when a column is null. Every
 * pre-existing fixture was fully populated, so the CRM had never been
 * observed rendering an incomplete service order — which is the normal case
 * for a row imported from Omie, not an edge case.
 *
 * Oracle: `customer-services/spec.md:94` — each row shows "date, customer,
 * vehicle, plate, description or kind, products/oil, value, odometer,
 * situação, and origin with its Omie identifier — indicating absent data
 * without inventing values. A service with no linked vehicle SHALL be shown
 * as such rather than omitted or given a placeholder vehicle." That sentence
 * fixes all three behaviours asserted here: absent data is INDICATED (so a
 * blank cell would fail), it is not INVENTED (so a fabricated plate or a
 * zero odometer would fail), and a vehicle-less service is SHOWN AS SUCH
 * (so omitting the row or printing a placeholder car would fail).
 * `conversas/spec.md:485` states the same rule for the sibling drill-in:
 * "Missing data SHALL be indicated without inventing values."
 *
 * Axes
 *   A1 vehicle identity: fully absent / present (present is pre-covered)
 *   A2 odometer: null / a reading
 *   A3 situação: null / a value
 *   A4 origin: with an Omie id / without one
 *   A5 title source: `description` / falls back to `kind` / nothing to join,
 *      so the literal "Serviço"
 *   A6 line-item quantity: null / a number
 *   A7 attributed quote: null / present
 *   A8 originating service labels (scheduled drill-in): both null / at least
 *      one present
 *
 * Outputs
 *   O1 the Portuguese fallback string actually rendered
 *   O2 ABSENCE of an invented value (no plate, no "0 km", no "×" multiplier)
 *
 * Sampled cells
 *   service with nothing filled | A1-A7 absent | O1,O2 | fails if any cell is
 *                                 blank, or if a placeholder vehicle appears
 *   scheduled message whose      | A8 both null | O1    | fails if an empty
 *   origin service has no labels                          dot-joined string is
 *                                                         shown instead of copy
 *
 * Both `it`s assert several facets of ONE logical outcome — "this screen
 * renders an empty record without inventing anything" — which is the
 * multi-assert case `testing-vitest` allows. Splitting per field would mean
 * eight identical MSW fixtures and eight renders for no extra signal.
 *
 * Decision / branch map (the eight branches this file exists to close)
 *   :60  `row.vehicleYear == null ? null : String(...)` — null side
 *   :89  `row.description ?? row.kind` — right side, description null; and the
 *        `|| "Serviço"` fallback of the same expression, taken by the third
 *        `it` where date, description and kind are all absent
 *   :111 `detailVehicleLabel(row) || "Sem veículo vinculado"` — fallback side
 *   :114 `formatOdometer(row.odometerKm) || NOT_INFORMED` — fallback side
 *   :116 `row.status ?? NOT_INFORMED` — right side
 *   :117 `row.omieId ? "Omie · OS ..." : row.origin` — false side
 *   :134 `item.quantity == null ? "" : ...` — null side
 *   :267 `joinDot([performedAt, description]) || "Serviço sem descrição"` —
 *        fallback side, both labels null
 *   The TRUE side of each is already taken by `ConversasPage.services.test.tsx`
 *   and `ConversasPage.scheduled.test.tsx`, which is why this file samples
 *   only the absent side rather than re-covering both.
 *
 * Out of scope, with reason
 *   - Loading and error states of both drill-ins: already covered by
 *     `ConversasPage.services.test.tsx` ("shows Portuguese loading then error
 *     and retry for services") and `ConversasPage.scheduled.test.tsx`.
 *   - `row.items.length === 0` (the "Nenhum item lançado nesta OS" copy):
 *     covered; this fixture deliberately carries ONE item so that the
 *     null-quantity branch at :134 is reachable, which an empty list would
 *     make unreachable.
 *   - The `amount`/`lineAmount` currency formatting itself: `helpers.test.ts`
 *     owns `formatAmount`, including its null case.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ScheduledMessageDetail, ServiceDetail } from "@select-lub/shared-types";
import { AppProviders } from "../AppProviders.js";
import { server } from "../../test/msw/server.js";
import { ScheduledMessageDrillIn, ServiceDrillIn } from "./drill-ins.js";

function providers(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<AppProviders queryClient={queryClient}>{children}</AppProviders>);
}

/**
 * A service order with every optional column null — the shape an Omie import
 * produces when the OS carries only a kind and a total.
 */
const bareService: ServiceDetail = {
  id: "svc_1",
  customerId: "cus_1",
  unitId: "unit_1",
  vehicleId: null,
  omieId: null,
  performedAt: null,
  description: null,
  kind: "Troca de óleo",
  status: null,
  amount: 250,
  odometerKm: null,
  origin: "crm",
  items: [
    {
      id: "item_1",
      serviceId: "svc_1",
      description: "Motul 5100 5W-30",
      kind: null,
      quantity: null,
      unitAmount: null,
      lineAmount: 250,
      oilViscosity: null,
      oilBrand: null,
    },
  ],
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
  customerName: "Ana",
  vehiclePlate: null,
  vehicleMake: null,
  vehicleModel: null,
  vehicleYear: null,
  attributedQuote: null,
  vehicleHistory: [],
};

const bareSchedule: ScheduledMessageDetail = {
  id: "sch_1",
  customerId: "cus_1",
  conversationId: "con_1",
  serviceId: "svc_1",
  returnReminderMessageId: null,
  templateId: null,
  text: "Sua revisão está próxima.",
  scheduledAt: "2026-09-10T15:00:00.000Z",
  timeZone: "America/Sao_Paulo",
  status: "SCHEDULED",
  idempotencyKey: "idem-1",
  suggestedAt: null,
  suggestionSource: null,
  createdByUserId: "usr_1",
  createdAt: "2026-08-01T12:00:00.000Z",
  lastError: null,
  templateName: null,
  createdByName: null,
  // Present, but carrying neither a date nor a description — the case the
  // dot-join collapses to an empty string.
  originatingService: { id: "svc_1", omieId: null, description: null, performedAt: null },
};

describe("ServiceDrillIn with an empty service order", () => {
  it("indicates every absent column in Portuguese and invents no vehicle", async () => {
    server.use(http.get("*/api/services/:id", () => HttpResponse.json(bareService)));

    providers(<ServiceDrillIn serviceId="svc_1" onBack={() => {}} onProgramar={() => {}} />);
    const detail = await screen.findByRole("region", { name: "Serviço" });

    // Shown as having no vehicle, per customer-services:94 — not omitted, and
    // not given a placeholder car.
    expect(await within(detail).findByText("Sem veículo vinculado")).toBeInTheDocument();
    // Odometer and situação each say so rather than rendering blank or "0".
    expect(within(detail).getAllByText("Não informado")).toHaveLength(2);
    expect(within(detail).queryByText("0 km")).not.toBeInTheDocument();
    // Origin without an Omie id falls back to the plain origin, and must not
    // print an "OS" label with nothing after it.
    expect(within(detail).getByText("crm")).toBeInTheDocument();
    expect(within(detail).queryByText(/Omie · OS/)).not.toBeInTheDocument();
    // A quantity-less line item shows no multiplier rather than "null ×".
    expect(within(detail).queryByText(/×/)).not.toBeInTheDocument();
    expect(within(detail).getByText("Nenhum orçamento atribuído a este serviço")).toBeInTheDocument();
  });

  it("titles a service with no description by its kind", async () => {
    server.use(http.get("*/api/services/:id", () => HttpResponse.json(bareService)));

    providers(<ServiceDrillIn serviceId="svc_1" onBack={() => {}} onProgramar={() => {}} />);
    const detail = await screen.findByRole("region", { name: "Serviço" });

    expect(await within(detail).findByText("Troca de óleo")).toBeInTheDocument();
  });

  it("falls back to the bare word Serviço when date, description and kind are all absent", async () => {
    // The last resort of the title chain: with nothing to join, the header
    // must still name what the reader is looking at rather than render an
    // empty heading above a populated panel.
    const untitled = { ...bareService, kind: null };
    server.use(http.get("*/api/services/:id", () => HttpResponse.json(untitled)));

    providers(<ServiceDrillIn serviceId="svc_1" onBack={() => {}} onProgramar={() => {}} />);
    const detail = await screen.findByRole("region", { name: "Serviço" });

    expect(await within(detail).findByText("Serviço")).toBeInTheDocument();
  });
});

describe("ScheduledMessageDrillIn whose originating service has no labels", () => {
  it("names the service as undescribed rather than showing an empty line", async () => {
    server.use(http.get("*/api/scheduled-messages/:id", () => HttpResponse.json(bareSchedule)));

    providers(
      <ScheduledMessageDrillIn
        scheduleId="sch_1"
        conversationId="con_1"
        connected
        onBack={() => {}}
      />,
    );
    const detail = await screen.findByRole("region", { name: "Mensagem programada" });

    expect(await within(detail).findByText("Serviço sem descrição")).toBeInTheDocument();
    // The absent template and creator get their own distinct copy, so a
    // reader can tell "no template" from "no creator recorded".
    expect(within(detail).getByText("Sem template")).toBeInTheDocument();
    expect(within(detail).getByText("Não informado")).toBeInTheDocument();
  });
});
