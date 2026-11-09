/**
 * Test design (testing-strategy)
 *
 * Setup: ServicosPage rendered under AppProviders + MemoryRouter, MSW serving
 * `GET /api/services` (paged envelope) and `GET /api/services/:id` (detail).
 *
 * Oracle: build-servicos-list-detail customer-services delta — "Standalone
 * Serviços screen lists all customers' services" and "Unit service listing is
 * filtered, searched and paged".
 *
 * Axes
 *   A1 list state: loading / error / empty unit / no filter match / populated
 *   A2 row fields: plate, odômetro, produtos, situação, origem+OS present
 *   A3 vehicle link: linked / null vehicleId
 *   A4 selection: initial row / a second row chosen
 *   A5 detail content: items + attributed quote / neither
 *   A6 paging: hasMore false / true then "Carregar mais" appends
 *   A7 search: term reaches the request query
 *   A8 detail state: populated / fetch fails
 *   A9 vehicleHistory: past services present / empty with vehicleId null
 *      / empty with vehicleId linked (this last arm is already exercised,
 *      unasserted, by the no-items detail it below — see D9)
 *   A10 produtos: an item carrying oil brand/viscosity vs. the empty-items
 *      fallback already sampled
 *   A11 date range filter: De/Até reach the request query
 *   A12 absent optional fields: performedAt, amount, odometerKm all null
 *
 * Outputs: O1 rendered text; O2 the query string the client sent; O3 absence
 * O4 no invented date/amount/km literal ("Invalid Date", "R$ NaN", "null")
 *
 * Sampled-cell
 *   it                                          | axes        | expect | fails if
 *   renders the row fields the old screen dropped | A2         | O1  | plate/km/produtos absent
 *   marks a service with no linked vehicle        | A3         | O1  | invented vehicle
 *   selects the first row and shows its detail    | A4,A5      | O1  | detail empty
 *   choosing another row swaps the detail         | A4         | O1  | list unmounted
 *   detail without items or quote says so         | A5         | O1  | blank panel
 *   empty unit differs from no filter match       | A1         | O1  | same copy
 *   loading copy while in flight                  | A1         | O1  | rows shown
 *   error copy and retry                          | A1         | O1  | no alert
 *   search reaches the request                    | A7         | O2  | term dropped
 *   carregar mais appends the next page           | A6         | O1  | replaces rows
 *   heading is not one of the nav links           | A1         | O3  | h1 inside nav
 *   detail error copy and retry                    | A8         | O1  | no alert, or list breaks too
 *   vehicle history lists past services             | A9 present | O1  | invented or blank
 *   no history and no linked vehicle explains why   | A9 null   | O1  | same copy as linked-empty
 *   produtos shows oil brand/viscosity over description | A10  | O1  | description leaks through
 *   date range reaches the request                  | A11       | O2  | dropped like search once was
 *   absent optional fields render nothing invented   | A12      | O4  | Invalid Date / R$ NaN / "null"
 *
 * Decision map (ServicosPage.tsx)
 *   D1 list.isLoading      T: loading it; F: others
 *   D2 list.isError        T: error it; F: populated
 *   D3 rows.length === 0   T: empty its; F: populated
 *   D4 filtered            T: no-match copy; F: empty-unit copy
 *   D5 vehicle === ""      T: unlinked row it; F: linked row it
 *   D6 attributedQuote null T: "nenhum orçamento"; F: quote it
 *   D7 items.length === 0  T: "nenhum item"; F: items it
 *   D8 list.hasNextPage    T: carregar mais it; F: single-page its
 *   D9 vehicleHistory empty T: two its below (vehicleId null vs the
 *      already-covered linked-empty arm from the no-items detail it); F:
 *      the new "lists past services" it
 *   D10 detail.isError || !detail.data   T: the new detail-error it; F:
 *      every other detail it (detail.data always present there)
 *   D11 productsLabel's oilBrand/oilViscosity `.some(Boolean)` T: the new
 *      produtos it; F: already covered by the "Sem produtos lançados" it
 *   D12 formatDate/formatAmount/formatKm's `== null` guards — T: the new
 *      absent-fields it; F: every other it in this file (all give real
 *      values). formatDate's regex-no-match arm (line 33) is NOT sampled:
 *      `performedAt` is a Prisma DateTime serialized as ISO, so a non-ISO
 *      string is not a shape the API can actually send — contract-hidden,
 *      named rather than forced.
 *
 * Out of scope: Conversas rail Serviços; Playwright; the API's own paging
 * (packages/core/src/modules/services/list-unit-services/tests/).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Service, ServiceDetail, UnitServiceRow } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ServicosPage } from "./ServicosPage.js";
import { server } from "../test/msw/server.js";

function row(partial: Partial<UnitServiceRow> & Pick<UnitServiceRow, "id">): UnitServiceRow {
  return {
    customerId: "cus-1",
    vehicleId: "veh-1",
    omieId: "10482",
    unitId: "unit-1",
    performedAt: "2026-03-12T00:00:00.000Z",
    description: "Troca de óleo",
    kind: null,
    status: "Concluído",
    amount: 189.9,
    odometerKm: 42300,
    origin: "omie",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    customerName: "Roberto Aparecido",
    vehiclePlate: "ABC-1D23",
    vehicleMake: "Toyota",
    vehicleModel: "Corolla",
    vehicleYear: 2019,
    ...partial,
  };
}

function page(rows: UnitServiceRow[], extra: { hasMore?: boolean; nextCursor?: string | null } = {}) {
  const hasMore = extra.hasMore ?? false;
  return {
    rows,
    hasMore,
    nextCursor: hasMore ? (extra.nextCursor ?? "cursor-2") : null,
    totalCount: rows.length,
    totalAmount: rows.reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
  };
}

function detail(partial: Partial<ServiceDetail> & Pick<ServiceDetail, "id">): ServiceDetail {
  return {
    ...row({ id: partial.id }),
    attributedQuote: null,
    vehicleHistory: [],
    ...partial,
  };
}

/** Serves the listing plus a detail for whichever service is asked for. */
function serve(listing: ReturnType<typeof page>, details: ServiceDetail[] = []) {
  server.use(
    http.get("*/api/services", () => HttpResponse.json(listing)),
    http.get("*/api/services/:id", ({ params }) => {
      const found = details.find((entry) => entry.id === params.id);
      return HttpResponse.json(found ?? detail({ id: String(params.id) }));
    }),
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ServicosPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => {
  server.resetHandlers();
});

describe("ServicosPage list", () => {
  it("renders the row fields the previous screen dropped", async () => {
    serve(page([row({ id: "svc-1" })]));
    renderPage();

    expect(await screen.findByText("Roberto Aparecido")).toBeInTheDocument();
    expect(screen.getByText(/ABC-1D23/)).toBeInTheDocument();
    expect(screen.getByText(/42\.300 km/)).toBeInTheDocument();
    expect(screen.getByText(/Sem produtos lançados/)).toBeInTheDocument();
    expect(screen.getAllByText(/Concluído/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/OS 10482/).length).toBeGreaterThan(0);
  });

  it("marks a service with no linked vehicle instead of inventing one", async () => {
    serve(
      page([
        row({
          id: "svc-1",
          vehicleId: null,
          vehiclePlate: null,
          vehicleMake: null,
          vehicleModel: null,
          vehicleYear: null,
        }),
      ]),
    );
    renderPage();

    expect(await screen.findAllByText(/Sem veículo vinculado/)).not.toHaveLength(0);
    expect(screen.queryByText(/Toyota/)).not.toBeInTheDocument();
  });

  it("shows the empty-unit copy, distinct from a filtered miss", async () => {
    serve(page([]));
    renderPage();

    expect(await screen.findByText("Nenhum serviço registrado")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum serviço para esses filtros")).not.toBeInTheDocument();
  });

  it("says nothing matched when a search returns no rows", async () => {
    serve(page([]));
    renderPage();
    await screen.findByText("Nenhum serviço registrado");

    await userEvent.type(screen.getByLabelText("Cliente, placa ou OS"), "zzz");

    expect(await screen.findByText("Nenhum serviço para esses filtros")).toBeInTheDocument();
  });

  it("shows loading copy while the listing is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("*/api/services", async () => {
        await gate;
        return HttpResponse.json(page([]));
      }),
    );
    renderPage();

    expect(await screen.findByText("Carregando serviços")).toBeInTheDocument();
    release();
  });

  it("shows Portuguese error copy and retries", async () => {
    server.use(http.get("*/api/services", () => HttpResponse.json({}, { status: 500 })));
    renderPage();

    expect(await screen.findByText("Não foi possível carregar os serviços")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("shows the oil brand and viscosity over a raw item description", async () => {
    serve(
      page([
        row({
          id: "svc-1",
          items: [
            {
              id: "i-1",
              serviceId: "svc-1",
              description: "Óleo lubrificante",
              kind: null,
              quantity: 1,
              unitAmount: null,
              lineAmount: null,
              oilViscosity: "5W-30",
              oilBrand: "Motul",
            },
          ],
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText(/Motul 5W-30/)).toBeInTheDocument();
    expect(screen.queryByText(/Óleo lubrificante/)).not.toBeInTheDocument();
  });

  it("renders no invented value for a service missing its date, amount, odometer and status", async () => {
    serve(
      page([row({ id: "svc-1", performedAt: null, amount: null, odometerKm: null, status: null })]),
    );
    const { container } = renderPage();

    await screen.findByText("Roberto Aparecido");
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bnull\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/km/)).not.toBeInTheDocument();
    // StatusChip renders nothing at all (not an empty chip) for a null status.
    expect(container.querySelectorAll(".MuiChip-root")).toHaveLength(0);
  });

  it("keeps the page heading out of the nav row", async () => {
    serve(page([row({ id: "svc-1" })]));
    renderPage();
    await screen.findAllByText("Roberto Aparecido");

    const heading = screen.getByRole("heading", { name: "Serviços" });
    expect(within(screen.getByRole("navigation")).queryByRole("heading")).toBeNull();
    expect(heading).toBeInTheDocument();
  });
});

describe("ServicosPage selection and detail", () => {
  it("selects the first service and shows it in detail beside the list", async () => {
    serve(
      page([row({ id: "svc-1" }), row({ id: "svc-2", customerName: "Fernanda Cardoso" })]),
      [
        detail({
          id: "svc-1",
          items: [
            {
              id: "i-1",
              serviceId: "svc-1",
              description: "Motul 5100 5W-30",
              kind: null,
              quantity: 4,
              unitAmount: 34.9,
              lineAmount: 139.6,
              oilViscosity: "5W-30",
              oilBrand: "Motul",
            },
          ],
          attributedQuote: { quoteId: "q-1", sentAt: "2026-03-08T00:00:00.000Z", ruleVersion: 1 },
        }),
      ],
    );
    renderPage();

    expect(await screen.findByText("Motul 5100 5W-30")).toBeInTheDocument();
    expect(screen.getByText(/Orçamento enviado em 08\/03\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/regra versão 1/)).toBeInTheDocument();
  });

  it("swaps the detail when another row is chosen and keeps the list rendered", async () => {
    serve(
      page([row({ id: "svc-1" }), row({ id: "svc-2", customerName: "Fernanda Cardoso" })]),
      [
        detail({ id: "svc-1" }),
        detail({ id: "svc-2", customerName: "Fernanda Cardoso", description: "Alinhamento" }),
      ],
    );
    renderPage();
    await screen.findAllByText("Roberto Aparecido");

    await userEvent.click(screen.getByText("Fernanda Cardoso"));

    expect(await screen.findByRole("heading", { name: /Alinhamento/ })).toBeInTheDocument();
    expect(screen.getByText("Roberto Aparecido")).toBeInTheDocument();
  });

  it("states plainly when a service has no items and no attributed quote", async () => {
    serve(page([row({ id: "svc-1" })]), [detail({ id: "svc-1", items: [] })]);
    renderPage();

    expect(await screen.findByText("Nenhum item lançado nesta OS")).toBeInTheDocument();
    expect(screen.getByText("Nenhum orçamento atribuído a este serviço")).toBeInTheDocument();
  });

  it("shows Portuguese error copy and a retry for the detail pane when it fails to load", async () => {
    server.use(
      http.get("*/api/services", () => HttpResponse.json(page([row({ id: "svc-1" })]))),
      http.get("*/api/services/:id", () => HttpResponse.json({}, { status: 500 })),
    );
    renderPage();
    await screen.findByText("Roberto Aparecido");

    expect(await screen.findByText("Não foi possível carregar o serviço")).toBeInTheDocument();
    // The list stays intact — only the detail pane failed, not the screen.
    expect(screen.getByText("Roberto Aparecido")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("lists past services in Histórico do veículo when the vehicle has some", async () => {
    const past: Service = {
      id: "svc-0",
      customerId: "cus-1",
      vehicleId: "veh-1",
      omieId: "10399",
      unitId: "unit-1",
      performedAt: "2025-11-02T00:00:00.000Z",
      description: "Troca de óleo",
      kind: null,
      status: "Concluído",
      amount: 149.9,
      odometerKm: 38100,
      origin: "omie",
      items: [],
      createdAt: "2025-11-02T00:00:00.000Z",
      updatedAt: "2025-11-02T00:00:00.000Z",
    };
    serve(page([row({ id: "svc-1" })]), [detail({ id: "svc-1", vehicleHistory: [past] })]);
    renderPage();

    expect(await screen.findByText("02/11/2025")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s?149,90/)).toBeInTheDocument();
    expect(screen.getByText(/38\.100 km/)).toBeInTheDocument();
  });

  it("explains a missing history by the vehicle link, not by a shared empty copy", async () => {
    serve(
      page([row({ id: "svc-1", vehicleId: null })]),
      [detail({ id: "svc-1", vehicleId: null, vehicleHistory: [] })],
    );
    renderPage();

    expect(
      await screen.findByText("Sem veículo vinculado — histórico indisponível"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Primeiro serviço registrado para este veículo")).not.toBeInTheDocument();
  });
});

describe("ServicosPage filtering and paging", () => {
  it("sends the search term to the listing request", async () => {
    const seen: string[] = [];
    server.use(
      http.get("*/api/services/:id", () => HttpResponse.json(detail({ id: "svc-1" }))),
      http.get("*/api/services", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("search") ?? "");
        return HttpResponse.json(page([row({ id: "svc-1" })]));
      }),
    );
    renderPage();
    await screen.findAllByText("Roberto Aparecido");

    await userEvent.type(screen.getByLabelText("Cliente, placa ou OS"), "ABC");

    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toBe("ABC");
  });

  it("sends the De/Até date range to the listing request", async () => {
    const seen: { from: string | null; to: string | null }[] = [];
    server.use(
      http.get("*/api/services/:id", () => HttpResponse.json(detail({ id: "svc-1" }))),
      http.get("*/api/services", ({ request }) => {
        const url = new URL(request.url);
        seen.push({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
        return HttpResponse.json(page([row({ id: "svc-1" })]));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toEqual({ from: null, to: null });

    await user.type(screen.getByLabelText("De"), "2026-01-01");
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toEqual({ from: "2026-01-01", to: null });

    await user.type(screen.getByLabelText("Até"), "2026-01-31");
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(screen.getByText(/01\/01\/2026 – 31\/01\/2026/)).toBeInTheDocument();
  });

  it('sends no returnState by default, and "vencido" once Retorno vencido is chosen', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get("*/api/services/:id", () => HttpResponse.json(detail({ id: "svc-1" }))),
      http.get("*/api/services", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("returnState"));
        return HttpResponse.json(page([row({ id: "svc-1" })]));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toBeNull();

    await user.click(screen.getByLabelText("Situação"));
    await user.click(await screen.findByRole("option", { name: "Retorno vencido" }));

    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toBe("vencido");
  });

  it("sends aproximando for Retorno se aproximando, and back to no filter for Todas", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get("*/api/services/:id", () => HttpResponse.json(detail({ id: "svc-1" }))),
      http.get("*/api/services", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("returnState"));
        return HttpResponse.json(page([row({ id: "svc-1" })]));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("Roberto Aparecido");

    await user.click(screen.getByLabelText("Situação"));
    await user.click(await screen.findByRole("option", { name: "Retorno se aproximando" }));
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toBe("aproximando");

    await user.click(screen.getByLabelText("Situação"));
    await user.click(await screen.findByRole("option", { name: "Todas" }));
    await screen.findAllByText("Roberto Aparecido");
    expect(seen.at(-1)).toBeNull();
  });

  it("reads the same VehicleReturn row Follow-up reads — one definition of vencido, not two", async () => {
    // The screen does not classify vencido/aproximando itself; it only ever
    // forwards the chosen filter to GET /services, which is where the
    // classification lives (returnStateByService, shared with Follow-up's
    // aggregate.ts). This pins that the client stays a pass-through: a
    // service returned for "vencido" is trusted and rendered, not re-checked
    // against a second, client-side notion of overdue.
    server.use(
      http.get("*/api/services/:id", () => HttpResponse.json(detail({ id: "svc-1" }))),
      http.get("*/api/services", ({ request }) => {
        const returnState = new URL(request.url).searchParams.get("returnState");
        return HttpResponse.json(
          returnState === "vencido" ? page([row({ id: "svc-1", customerName: "Carlos Mendes" })]) : page([]),
        );
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByLabelText("Situação"));
    await user.click(await screen.findByRole("option", { name: "Retorno vencido" }));

    expect(await screen.findAllByText("Carlos Mendes")).not.toHaveLength(0);
  });

  it("appends the next page rather than replacing the loaded rows", async () => {
    let call = 0;
    server.use(
      http.get("*/api/services/:id", ({ params }) => HttpResponse.json(detail({ id: String(params.id) }))),
      http.get("*/api/services", () => {
        call += 1;
        return HttpResponse.json(
          call === 1
            ? page([row({ id: "svc-1" })], { hasMore: true })
            : page([row({ id: "svc-2", customerName: "Fernanda Cardoso" })]),
        );
      }),
    );
    renderPage();
    await screen.findAllByText("Roberto Aparecido");

    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    expect(await screen.findByText("Fernanda Cardoso")).toBeInTheDocument();
    expect(screen.getAllByText("Roberto Aparecido").length).toBeGreaterThan(0);
  });
});
