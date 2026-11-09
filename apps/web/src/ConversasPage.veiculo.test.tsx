/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: conversas Veículo drill-in — in-rail view, voltar restores the
 * profile stack, vehicle B never lists vehicle A's services, Portuguese
 * loading/empty/error, chevron row opens the drill-in. Plus the
 * customer-vehicles delta's Adicionar veículo destination: the six typeable
 * `Vehicle` fields and no system field, reachable from the populated and the
 * empty vehicle states, claiming no confirmed Omie write while GitHub #29 is
 * open.
 *
 * Axes
 *   A1 vehicle opened — A vs B
 *   A2 GET vehicle services — ok / empty / slow / 500
 *   A3 railView — veiculo vs stack (voltar)
 *   A4 vehicle list — populated vs empty (both offer Adicionar veículo)
 *   A5 typed fields — all six vs a subset left blank
 *   A6 POST vehicles — 201 vs 500
 *
 * Outputs
 *   O1 only that vehicle's services
 *   O2 empty copy
 *   O3 loading / error
 *   O4 Tags/Veículos visible after Voltar
 *   O5 dialog carries the six typeable fields and no system field
 *   O6 the GitHub #29 unconfirmed-mapping line
 *   O7 POST body carries only the typed fields; dialog closes
 *   O8 Portuguese create error; dialog stays open
 *
 * Sampled-cell
 *   open A                  | A1 A            | O1 A's OS | B's OS
 *   open B                  | A1 B            | O1 B's OS | A's OS
 *   empty                   | A2 empty        | O2 | invented OS
 *   error                   | A2 500          | O3 | silent
 *   Voltar                  | A3 stack        | O4 | stays drill-in
 *   add from populated      | A4 populated    | O5 | a system field offered
 *   add from empty          | A4 empty        | O5 dialog opens | no control
 *   save a subset           | A5 subset A6 201| O6 + O7 | "" sent for blanks
 *   create fails            | A6 500          | O8 | dialog closes silently
 *
 * Decision map (conversas/vehicles.tsx VehicleDrillIn + AddVehicleDialog /
 * contact-rail railView)
 *   D1 railView === veiculo T: drill-in its; F: Voltar it
 *   D2 GET error            T: error it; F: ok/empty
 *   D3 length === 0         T: empty it; F: A/B its
 *   D4 addVehicleOpen       T: dialog its; F: the stack cases
 *   D5 draft field blank    T: omitted from the body; F: sent
 *   D6 addVehicle.isError   T: Portuguese error; F: dialog closes
 *
 * Out of scope: standalone Serviços; Playwright.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Service, Vehicle } from "@select-lub/shared-types";
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
    customerId: "cus-1",
    vehicleId: "veh-a",
    omieId: null,
    unitId: "unit-1",
    performedAt: "2026-03-12T00:00:00.000Z",
    description: "Troca A",
    kind: null,
    status: null,
    amount: 189.9,
    odometerKm: 42300,
    origin: "crm",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

const vehA: Vehicle = {
  id: "veh-a",
  customerId: "cus-1",
  omieId: null,
  plate: "ABC1D23",
  make: "Toyota",
  model: "Corolla",
  version: "1.8 XEi",
  year: 2019,
  odometerKm: 42300,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const vehB: Vehicle = {
  ...vehA,
  id: "veh-b",
  plate: "XYZ9F88",
  make: "Honda",
  model: "Civic",
  version: "EXL",
  year: 2021,
  odometerKm: null,
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

function stubVehicles(
  servicesByVehicle: Record<string, Service[]>,
  status = 200,
  vehicles: Vehicle[] = [vehA, vehB],
) {
  const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto" });
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([conv])),
    http.get("*/api/conversations/:id/vehicles", () =>
      HttpResponse.json({ customerId: "cus-1", vehicles }),
    ),
    http.get("*/api/vehicles/:id/services", ({ params }) => {
      if (status !== 200) {
        return HttpResponse.json({ error: "boom" }, { status });
      }
      return HttpResponse.json(servicesByVehicle[String(params.id)] ?? []);
    }),
  );
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Conversas Veículo drill-in", () => {
  it("opens vehicle A's drill-in without listing vehicle B's services", async () => {
    stubVehicles({
      "veh-a": [serviceRow({ id: "svc-a", description: "Troca A" })],
      "veh-b": [
        serviceRow({
          id: "svc-b",
          vehicleId: "veh-b",
          description: "Troca B",
          performedAt: "2025-11-02T00:00:00.000Z",
        }),
      ],
    });
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
  // Substring, not the exact plate: the two variants name this button
  // differently and both are correct. cursor's row shows the plate alone, so
  // its accessible name IS "ABC1D23"; antigravity's shows identity and plate
  // joined ("Toyota Corolla 1.8 XEi · ABC1D23"), which still satisfies WCAG
  // 2.5.3 because the visible text carries the plate. An exact-name query
  // passes on cursor and fails on antigravity against a button that is present
  // and clickable. No sibling button in the row contains a plate, so the
  // substring is unambiguous.
    await user.click(await screen.findByRole("button", { name: /ABC1D23/ }));

    const rail = await screen.findByRole("region", { name: "Veículo" });
    expect(within(rail).getByText(/Troca A/)).toBeInTheDocument();
    expect(within(rail).queryByText(/Troca B/)).not.toBeInTheDocument();
  });

  it("opens vehicle B's drill-in without listing vehicle A's services", async () => {
    stubVehicles({
      "veh-a": [serviceRow({ id: "svc-a", description: "Troca A" })],
      "veh-b": [serviceRow({ id: "svc-b", vehicleId: "veh-b", description: "Troca B" })],
    });
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: /XYZ9F88/ }));

    const rail = await screen.findByRole("region", { name: "Veículo" });
    expect(await within(rail).findByText(/Troca B/)).toBeInTheDocument();
    expect(within(rail).queryByText(/Troca A/)).not.toBeInTheDocument();
  });

  it("shows Portuguese empty copy when the vehicle has zero services", async () => {
    stubVehicles({ "veh-a": [], "veh-b": [] });
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: /ABC1D23/ }));

    expect(await screen.findByText("Nenhum serviço registrado para este veículo")).toBeInTheDocument();
    expect(screen.queryByText(/Troca A/)).not.toBeInTheDocument();
  });

  it("shows Portuguese error copy on a failed vehicle listing", async () => {
    stubVehicles({}, 500);
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: /ABC1D23/ }));

    expect(await screen.findByText("Não foi possível carregar os dados deste veículo")).toBeInTheDocument();
  });

  it("restores the profile stack on Voltar", async () => {
    stubVehicles({ "veh-a": [] });
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: /ABC1D23/ }));
    expect(await screen.findByRole("region", { name: "Veículo" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "← Voltar" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Veículo" })).not.toBeInTheDocument();
    });
    expect(screen.getByText("Veículos")).toBeInTheDocument();
    expect(screen.getByText("Contato")).toBeInTheDocument();
  });
});

describe("Conversas Adicionar veículo", () => {
  it("opens from the populated list with the six typeable fields and no system field", async () => {
    stubVehicles({ "veh-a": [] });
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: "Adicionar veículo" }));

    const dialog = await screen.findByRole("dialog", { name: "Adicionar veículo" });
    for (const label of ["Marca", "Modelo", "Versão", "Ano", "Placa", "Quilometragem atual"]) {
      expect(within(dialog).getByLabelText(label)).toBeEnabled();
    }
    // System fields are the API's to set; a form that offered them would invite
    // an operator to type an identifier the CRM owns.
    for (const systemField of ["Id", "Cliente", "Origem", "Omie", "Criado em", "Atualizado em"]) {
      expect(within(dialog).queryByLabelText(systemField)).not.toBeInTheDocument();
    }
  });

  it("opens from the empty vehicle state too", async () => {
    stubVehicles({}, 200, []);
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));

    expect(await screen.findByText("Nenhum veículo cadastrado")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Adicionar veículo" }));

    expect(await screen.findByRole("dialog", { name: "Adicionar veículo" })).toBeInTheDocument();
  });

  it("claims no confirmed Omie write and posts only the fields that were typed", async () => {
    stubVehicles({ "veh-a": [] });
    const creates: unknown[] = [];
    server.use(
      http.post("*/api/conversations/:id/vehicles", async ({ request }) => {
        creates.push(await request.json());
        return HttpResponse.json({ ...vehA, id: "veh-new", plate: "QRS4T56" }, { status: 201 });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: "Adicionar veículo" }));

    const dialog = await screen.findByRole("dialog", { name: "Adicionar veículo" });
    expect(
      within(dialog).getByText(
        "O espelhamento de veículo no Omie ainda não foi confirmado (GitHub #29). O veículo é gravado no CRM.",
      ),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Marca"), "Fiat");
    await user.type(within(dialog).getByLabelText("Ano"), "2022");
    await user.click(within(dialog).getByRole("button", { name: "Salvar veículo" }));

    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    // Modelo, Versão, Placa and Quilometragem were left blank, so they are
    // absent from the body rather than sent as empty strings.
    expect(creates[0]).toEqual({ make: "Fiat", year: 2022 });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Adicionar veículo" })).not.toBeInTheDocument();
    });
  });

  it("says so in Portuguese when the create fails and keeps the dialog open", async () => {
    stubVehicles({ "veh-a": [] });
    server.use(
      http.post("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: "Adicionar veículo" }));

    const dialog = await screen.findByRole("dialog", { name: "Adicionar veículo" });
    await user.type(within(dialog).getByLabelText("Placa"), "QRS4T56");
    await user.click(within(dialog).getByRole("button", { name: "Salvar veículo" }));

    expect(await within(dialog).findByText("Não foi possível salvar o veículo")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Adicionar veículo" })).toBeInTheDocument();
  });
});
