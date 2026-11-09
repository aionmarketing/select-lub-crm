/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: customer-services-rail-ui conversas delta — 2 most recent
 * services (`performedAt` desc, nulls last), Portuguese empty/loading/error,
 * "Ver tudo" only when count > 2, full-list switch with Voltar, enabled
 * Programar mensagem (opens the schedule form; scheduled-messages-ui).
 * No per-service edit (complete-omie-integration: Omie is the sole creator).
 * No invented dates on empty.
 *
 * Axes
 *   A1 count — 0 / 1 / 2 / 3 (BVA around the preview cap of 2)
 *   A2 customerId — null vs set
 *   A3 GET — ok / slow / 500
 *   A4 railView — stack vs servicosFull
 *   A5 Programar mensagem opens the schedule dialog (no edit affordance)
 *   A6 drill-in entry — preview row vs Ver tudo list row
 *   A7 GET /services/:id — ok / 500
 *   A8 detail shape — items + attributed quote vs neither
 *
 * Outputs
 *   O1 empty copy (no customer / zero services)
 *   O2 preview rows (cap 2)
 *   O3 Ver tudo present/absent
 *   O4 full list + Voltar restores Tags/Veículos
 *   O5 Programar mensagem enabled
 *   O6 schedule dialog open; no Editar serviço
 *   O7 loading / error
 *   O8 drill-in region with items and total, and no dialog opened
 *   O9 Voltar returns to the view the drill-in was opened from
 *   O10 Portuguese detail error + retry
 *   O11 attributed quote named, or the Portuguese "none" copy
 *
 * Sampled-cell
 *   unlinked                | A2 null           | O1 no-customer | invented date
 *   zero services           | A1 0, A2 set      | O1 empty OS    | invented date / Ver tudo
 *   one service             | A1 1              | O2 that row    | Ver tudo
 *   two services            | A1 2              | O2 both, no Ver tudo | hides one
 *   three — preview         | A1 3              | O2 two newest, Ver tudo | third row / no control
 *   three — Ver tudo       | A4 full           | O4 all three   | stays on preview
 *   Voltar                  | A4 stack          | O4 Tags        | stays on full list
 *   Programar mensagem      | listed row        | O5 enabled + dialog | disabled / absent
 *   no Editar serviço       | A5                | O6 absent           | edit button present
 *   loading                 | A3 slow           | O7 Carregando  | empty copy first
 *   error + retry           | A3 500            | O7 error copy  | silent fail
 *   drill-in from preview   | A6 preview A8 full| O8 items+total, no dialog | dialog opened
 *   Voltar to the stack     | A6 preview        | O9 Tags back   | lands on full list
 *   drill-in from Ver tudo  | A6 full list      | O9 back to the full list | lands on the stack
 *   quote-less, item-less OS| A8 neither        | O11 none copy + empty-items copy | invented quote
 *   detail 500 + retry      | A7 500            | O10 error copy | silent fail
 *
 * Decision map (conversas/contact-rail.tsx + conversas/drill-ins.tsx)
 *   D1 customerId == null     T: unlinked; F: zero/one/two/three
 *   D2 length === 0           T: zero; F: one/two/three
 *   D3 length > 2             T: three; F: 0/1/2
 *   D4 railView full          T: Ver tudo; F: preview / Voltar
 *   D5 GET error              T: error+retry; F: ok fixtures
 *   D6 GET loading            T: loading; F: populated
 *   D7 railView servicoDetail T: drill-in; F: preview / full list
 *   D8 drillReturnView full   T: Voltar to the full list; F: Voltar to the stack
 *   D9 attributedQuote null   T: none copy; F: the quote card
 *   D10 items.length === 0    T: empty-items copy; F: rows + total
 *   D11 detail GET error      T: error+retry; F: rendered detail
 *
 * Out of scope: standalone all-customers Serviços screen; schedule
 * confirm/cancel HTTP (ConversasPage.scheduled.test); Playwright.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Service, ServiceDetail, Vehicle } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

function summary(
  partial: Partial<ConversationSummary> & Pick<ConversationSummary, "id" | "phone">,
): ConversationSummary {
  return {
    contactLabel: partial.phone,
    lastSnippet: "oi",
    lastMessageAt: "2026-08-26T12:00:00.000Z",
    tags: [],
    sourceType: "UNKNOWN",
    unanswered: false,
    // Inbound-only default; `partial` still overrides it for a case that wants
    // a further stage.
    pipelineStage: "novosContatos",
    ...partial,
  };
}

function serviceRow(partial: Partial<Service> & Pick<Service, "id">): Service {
  return {
    customerId: "cus-svc",
    vehicleId: null,
    omieId: "os-svc",
    unitId: "unit-1",
    performedAt: null,
    description: null,
    kind: null,
    status: null,
    amount: null,
    odometerKm: null,
    origin: "omie",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

const newest = serviceRow({
  id: "svc-new",
  performedAt: "2026-03-12T00:00:00.000Z",
  description: "Troca de óleo",
  amount: 189.9,
  vehicleId: "veh-1",
});
const middle = serviceRow({
  id: "svc-mid",
  performedAt: "2025-11-02T00:00:00.000Z",
  description: "Alinhamento e balanceamento",
  amount: 120,
  vehicleId: "veh-1",
});
const oldest = serviceRow({
  id: "svc-old",
  performedAt: "2025-06-14T00:00:00.000Z",
  description: "Troca de filtro",
  amount: 89.9,
  vehicleId: "veh-2",
});

const corolla: Vehicle = {
  id: "veh-1",
  customerId: "cus-svc",
  omieId: null,
  plate: "ABC1D23",
  make: "Toyota",
  model: "Corolla",
  version: null,
  year: 2019,
  odometerKm: 42300,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function renderConversas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ConversasPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

async function openInbox(conv: ConversationSummary) {
  server.use(http.get("*/api/conversations", () => HttpResponse.json([conv])));
  renderConversas();
  await userEvent.setup().click(await screen.findByText(conv.contactLabel));
}

/**
 * `GET /services/:id` body for the newest fixture: two line items, an
 * attributed quote and the vehicle labels the detail read resolves itself.
 */
const newestDetail: ServiceDetail = {
  ...newest,
  odometerKm: 42300,
  status: "Concluído",
  customerName: "Roberto Aparecido",
  vehiclePlate: "ABC1D23",
  vehicleMake: "Toyota",
  vehicleModel: "Corolla",
  vehicleYear: 2019,
  items: [
    {
      id: "item-oil",
      serviceId: "svc-new",
      description: "Motul 5100 5W-30",
      kind: "oil",
      quantity: 4,
      unitAmount: 34.9,
      lineAmount: 139.6,
      oilViscosity: "5W-30",
      oilBrand: "Motul",
    },
    {
      id: "item-filter",
      serviceId: "svc-new",
      description: "Filtro de óleo",
      kind: null,
      quantity: 1,
      unitAmount: 32,
      lineAmount: 32,
      oilViscosity: null,
      oilBrand: null,
    },
  ],
  attributedQuote: { quoteId: "quo-1", sentAt: "2026-03-08T00:00:00.000Z", ruleVersion: 1 },
  vehicleHistory: [],
};

function stubServiceDetail(detail: ServiceDetail) {
  server.use(http.get("*/api/services/:id", () => HttpResponse.json(detail)));
}

function stubServices(services: Service[], customerId: string | null = "cus-svc") {
  server.use(
    http.get("*/api/conversations/:id/services", () =>
      HttpResponse.json({ customerId, services }),
    ),
    http.get("*/api/conversations/:id/vehicles", () =>
      HttpResponse.json({
        customerId,
        vehicles: customerId ? [corolla] : [],
      }),
    ),
  );
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Conversas services rail", () => {
  it("shows Portuguese empty services when no customer is linked and invents no OS date", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([], null);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(within(rail).getByText("Nenhum cliente vinculado")).toBeInTheDocument();
    expect(within(rail).queryByText(/12\/03\/2026/)).not.toBeInTheDocument();
    expect(within(rail).queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("shows Portuguese empty when the linked customer has zero services", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([]);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByText("Nenhum serviço encontrado")).toBeInTheDocument();
    expect(within(rail).queryByText(/12\/03\/2026/)).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("lists one service without Ver tudo", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubServices([newest]);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByText(/12\/03\/2026 · Troca de óleo/)).toBeInTheDocument();
    expect(within(rail).getByText(/Toyota Corolla 2019/)).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Programar mensagem" })).toBeEnabled();
  });

  it("lists two services in date order without Ver tudo", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([middle, newest]);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByText(/12\/03\/2026 · Troca de óleo/)).toBeInTheDocument();
    expect(within(rail).getByText(/02\/11\/2025 · Alinhamento e balanceamento/)).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("previews the two newest of three and shows Ver tudo", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([oldest, newest, middle]);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByText(/12\/03\/2026 · Troca de óleo/)).toBeInTheDocument();
    expect(within(rail).getByText(/02\/11\/2025 · Alinhamento e balanceamento/)).toBeInTheDocument();
    expect(within(rail).queryByText(/Troca de filtro/)).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Ver tudo" })).toBeInTheDocument();
  });

  it("switches to the full chronological list and restores the profile stack on Voltar", async () => {
    const conv = summary({
      id: "conv-1",
      phone: "11988887777",
      contactLabel: "Roberto Aparecido",
    });
    stubServices([oldest, newest, middle]);
    await openInbox(conv);

    const preview = await screen.findByRole("region", { name: "Serviços" });
    await userEvent.setup().click(within(preview).getByRole("button", { name: "Ver tudo" }));

    const full = await screen.findByRole("region", { name: "Serviços" });
    // Heading is the section name alone — the client is already named in
    // the thread, so it must not repeat here.
    expect(within(full).getByText("Serviços")).toBeInTheDocument();
    expect(within(full).queryByText(/Roberto Aparecido/)).not.toBeInTheDocument();
    expect(within(full).getByText(/12\/03\/2026 · Troca de óleo/)).toBeInTheDocument();
    expect(within(full).getByText(/02\/11\/2025 · Alinhamento e balanceamento/)).toBeInTheDocument();
    expect(within(full).getByText(/14\/06\/2025 · Troca de filtro/)).toBeInTheDocument();
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
    expect(screen.queryByText("Veículos")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: /Voltar/ }));

    expect(await screen.findByText("Tags")).toBeInTheDocument();
    expect(screen.getByText("Veículos")).toBeInTheDocument();
    expect(screen.queryByText(/Troca de filtro/)).not.toBeInTheDocument();
  });

  it("opens Programar mensagem without an edit affordance", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([newest]);
    server.use(
      http.get("*/api/services/:id/suggest-schedule-date", () =>
        HttpResponse.json({
          suggestedAt: "2026-07-15T03:00:00.000Z",
          suggestionSource: "six_months",
        }),
      ),
    );
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(within(rail).queryByRole("button", { name: "Editar serviço" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Salvar serviço" })).not.toBeInTheDocument();

    await userEvent.setup().click(within(rail).getByRole("button", { name: "Programar mensagem" }));

    expect(await screen.findByRole("dialog", { name: "Programar mensagem" })).toBeInTheDocument();
  });

  it("shows Portuguese loading then error and retry for services", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    let gets = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/services", async () => {
        gets += 1;
        if (gets === 1) {
          await firstGate;
          return HttpResponse.json({ error: "fail" }, { status: 500 });
        }
        return HttpResponse.json({ customerId: "cus-svc", services: [newest] });
      }),
    );
    renderConversas();
    await userEvent.setup().click(await screen.findByText(conv.contactLabel));

    expect(await screen.findByText("Carregando serviços")).toBeInTheDocument();
    releaseFirst();
    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByText("Não foi possível carregar os serviços")).toBeInTheDocument();
    await userEvent.setup().click(within(rail).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(rail).findByText(/12\/03\/2026 · Troca de óleo/)).toBeInTheDocument();
  });

  it("opens the service drill-in as a rail view, not a dialog, and Voltar restores the stack", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([newest]);
    stubServiceDetail(newestDetail);
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    await userEvent
      .setup()
      .click(within(rail).getByRole("button", { name: "Ver 12/03/2026 · Troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Serviço" });
    expect(within(detail).getByText("Toyota Corolla 2019 · ABC1D23")).toBeInTheDocument();
    expect(within(detail).getByText("42.300 km")).toBeInTheDocument();
    expect(within(detail).getByText("Omie · OS os-svc")).toBeInTheDocument();
    expect(within(detail).getByText("Motul 5100 5W-30")).toBeInTheDocument();
    expect(within(detail).getByText("Total")).toBeInTheDocument();
    expect(within(detail).getByText(/Orçamento enviado em 08\/03\/2026/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.setup().click(within(detail).getByRole("button", { name: /Voltar/ }));

    expect(await screen.findByText("Tags")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Serviço" })).not.toBeInTheDocument();
  });

  it("returns to the full list when the drill-in was opened from Ver tudo", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([oldest, newest, middle]);
    stubServiceDetail(newestDetail);
    await openInbox(conv);

    const preview = await screen.findByRole("region", { name: "Serviços" });
    await userEvent.setup().click(within(preview).getByRole("button", { name: "Ver tudo" }));
    const full = await screen.findByRole("region", { name: "Serviços" });
    await userEvent
      .setup()
      .click(within(full).getByRole("button", { name: "Ver 12/03/2026 · Troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Serviço" });
    await userEvent.setup().click(within(detail).getByRole("button", { name: /Voltar/ }));

    const back = await screen.findByRole("region", { name: "Serviços" });
    expect(within(back).getByText(/14\/06\/2025 · Troca de filtro/)).toBeInTheDocument();
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
  });

  it("says so in Portuguese when the service has no items and no attributed quote", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([newest]);
    stubServiceDetail({ ...newestDetail, items: [], attributedQuote: null });
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    await userEvent
      .setup()
      .click(within(rail).getByRole("button", { name: "Ver 12/03/2026 · Troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Serviço" });
    expect(within(detail).getByText("Nenhum item lançado nesta OS")).toBeInTheDocument();
    expect(
      within(detail).getByText("Nenhum orçamento atribuído a este serviço"),
    ).toBeInTheDocument();
    expect(within(detail).queryByText(/Orçamento enviado/)).not.toBeInTheDocument();
  });

  it("shows Portuguese error and retry when the service detail read fails", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    stubServices([newest]);
    let gets = 0;
    server.use(
      http.get("*/api/services/:id", () => {
        gets += 1;
        return gets === 1
          ? HttpResponse.json({ error: "fail" }, { status: 500 })
          : HttpResponse.json(newestDetail);
      }),
    );
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    await userEvent
      .setup()
      .click(within(rail).getByRole("button", { name: "Ver 12/03/2026 · Troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Serviço" });
    expect(await within(detail).findByText("Não foi possível carregar o serviço")).toBeInTheDocument();
    await userEvent.setup().click(within(detail).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(detail).findByText("Motul 5100 5W-30")).toBeInTheDocument();
  });
});
