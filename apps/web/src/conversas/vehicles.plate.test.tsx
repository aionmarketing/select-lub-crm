/**
 * Test design (testing-strategy)
 *
 * Setup: AddVehicleDialog (and one ConversasPage rail case) in AppProviders;
 * MSW. Query retry: false.
 *
 * Oracle: add-plate-lookup tasks 5.6–6.9 and the plate-lookup spec — blur-only
 * lookup, distinct unavailable/not-found/failed, silent fill, overwrite vs
 * keep, plate-sourced warning, miss retry, changed-field hint, no cadastro
 * write until Salvar, no displacement/fuel fields.
 *
 * Theme note (task 6.1): `f2dbf2f` is not on this branch. MuiButton labels in
 * the DOM stay sentence case. These tests MUST NOT assert upper-cased names.
 *
 * Axes
 *   A1 lookup trigger — keystroke / blur changed / blur same
 *   A2 response — found / unavailable / not_found / failed
 *   A3 identity before found — empty / filled
 *   A4 choice — overwrite / keep / warn confirm / warn cancel / retry decline
 *
 * Outputs: POST count; filled values; dialog copy; PATCH/POST vehicle body;
 * helper text; enabled manual fields
 *
 * Sampled-cell
 *   keystrokes                      | A1 type           | 0 lookups | a POST
 *   blur changed                    | A1 blur new       | 1 lookup | 0
 *   blur same after lookup          | A1 blur same      | still 1 | 2
 *   unavailable / not_found / fail  | A2 each           | distinct copy + editable | blocked
 *   empty found                     | A3 empty A2 found | fill, no overwrite dialog | prompt
 *   filled found                    | A3 filled         | overwrite dialog | silent fill
 *   overwrite / keep                | A4                | values vs marks | the other
 *   warn cancel                     | A4                | value stays | confirm
 *   warn confirm then type          | A4                | edit applied, no second warn | cancel
 *   retry decline                   | A4                | no second POST | retry:true
 *   retry confirm                   | A4                | second POST retry:true | decline
 *
 * Decision map (VehiclePlateFields)
 *   shouldLookup null T: keystroke/same its; F: blur-changed it
 *   status unavailable/not_found/failed/found  each banner it
 *   decideFoundLookup silent vs confirm        empty vs filled its
 *   overwrite vs keep                          both its
 *   sourced onChange T: warn its; F: unmarked type in empty-found it
 *
 * Out of scope: live provider; Playwright; Motul HTTP (options.test.ts).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Vehicle, VehicleCreateBody } from "@select-lub/shared-types";
import { AppProviders } from "../AppProviders.js";
import { ConversasPage } from "../ConversasPage.js";
import { useSelection } from "../selectionStore.js";
import { server } from "../../test/msw/server.js";
import { AddVehicleDialog } from "./vehicles.js";

const foundBody = {
  status: "found" as const,
  source: "mock" as const,
  provider: "mock",
  cached: false,
  fields: { make: "VW", model: "Gol", version: "1.0", year: 2020 },
};

function renderDialog(onSave: (body: VehicleCreateBody) => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <AppProviders queryClient={queryClient}>
      <AddVehicleDialog
        customerName="Ana"
        busy={false}
        failed={false}
        onSave={onSave}
        onClose={() => {}}
      />
    </AppProviders>,
  );
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Adicionar veículo plate lookup", () => {
  it("does not look up while the plate is being typed", async () => {
    const lookups: unknown[] = [];
    server.use(
      http.post("*/api/plate-lookups", async ({ request }) => {
        lookups.push(await request.json());
        return HttpResponse.json(foundBody);
      }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Placa"), "ABC1D23");

    expect(lookups).toHaveLength(0);
    expect(screen.queryByLabelText("Cilindrada")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Combustível")).not.toBeInTheDocument();
  }, 10_000);

  it("looks up once on blur of a changed valid plate and not again for the same plate", async () => {
    const lookups: unknown[] = [];
    server.use(
      http.post("*/api/plate-lookups", async ({ request }) => {
        lookups.push(await request.json());
        return HttpResponse.json(foundBody);
      }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    await waitFor(() => {
      expect(screen.getByLabelText("Marca")).toHaveValue("VW");
    });
    await user.click(screen.getByLabelText("Placa"));
    await user.tab();

    expect(lookups).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: /Substituir dados pela placa/ })).not.toBeInTheDocument();
  }, 10_000);

  it("leaves typed identity in place when a lookup misses, with no overwrite dialog", async () => {
    server.use(
      http.post("*/api/plate-lookups", () =>
        HttpResponse.json({
          status: "not_found",
          source: "provider",
          provider: "agregados-propria",
          cached: true,
          lookedUpAt: "2026-09-01T15:00:00.000Z",
          recordedOutcome: "miss",
        }),
      ),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Marca"), "Honda");
    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();

    expect(await screen.findByText("A consulta não devolveu dados para esta placa.")).toBeInTheDocument();
    expect(screen.getByLabelText("Marca")).toHaveValue("Honda");
    expect(screen.queryByRole("dialog", { name: /Substituir dados pela placa/ })).not.toBeInTheDocument();
  }, 10_000);

  it("leaves manual fields editable on unavailable, not-found and failed lookups", async () => {
    const user = userEvent.setup();
    const cases = [
      { body: { status: "unavailable" }, copy: "Consulta de placa indisponível. Preencha os dados à mão." },
      {
        body: {
          status: "not_found",
          source: "provider",
          provider: "agregados-propria",
          cached: true,
          lookedUpAt: "2026-09-01T15:00:00.000Z",
          recordedOutcome: "miss",
        },
        copy: "A consulta não devolveu dados para esta placa.",
      },
      {
        body: { status: "failed", reason: "provider_error" },
        copy: "Não foi possível consultar a placa. Tente de novo ou preencha os dados à mão.",
      },
    ] as const;

    for (const item of cases) {
      server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(item.body)));
      const { unmount } = renderDialog();
      await user.type(screen.getByLabelText("Placa"), "ABC1D23");
      await user.tab();
      expect(await screen.findByText(item.copy)).toBeInTheDocument();
      expect(screen.getByLabelText("Marca")).toBeEnabled();
      expect(screen.getByLabelText("Modelo")).toBeEnabled();
      unmount();
    }
  }, 15_000);

  it("does not call onSave until Salvar veículo, and then sends plate-sourced keys", async () => {
    const saves: VehicleCreateBody[] = [];
    server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(foundBody)));
    renderDialog((body) => {
      saves.push(body);
    });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    await waitFor(() => {
      expect(screen.getByLabelText("Marca")).toHaveValue("VW");
    });
    expect(saves).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Salvar veículo" }));

    expect(saves).toEqual([
      {
        plate: "ABC1D23",
        make: "VW",
        model: "Gol",
        version: "1.0",
        year: 2020,
        plateSourcedKeys: ["make", "model", "version", "year"],
      },
    ]);
  }, 10_000);

  it("asks before overwriting a filled identity and keeps values when that option is chosen", async () => {
    server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(foundBody)));
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Marca"), "Honda");
    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();

    const confirm = await screen.findByRole("dialog", { name: /Substituir dados pela placa ABC1D23/ });
    expect(within(confirm).getByText(/Marca/)).toBeInTheDocument();
    const overwrite = within(confirm).getByRole("button", { name: "Substituir pelos dados da placa" });
    const keep = within(confirm).getByRole("button", { name: "Manter valores atuais" });
    expect(overwrite.className).toMatch(/MuiButton-contained/);
    expect(keep.className).not.toMatch(/MuiButton-contained/);

    await user.click(keep);

    expect(screen.getByLabelText("Marca")).toHaveValue("Honda");
    expect(screen.queryByText("Valor da placa")).not.toBeInTheDocument();
  }, 10_000);

  it("replaces identity on overwrite, marks changed fields, and warns on a later sourced edit", async () => {
    server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(foundBody)));
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Marca"), "Honda");
    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    const confirm = await screen.findByRole("dialog", { name: /Substituir dados pela placa ABC1D23/ });
    await user.click(within(confirm).getByRole("button", { name: "Substituir pelos dados da placa" }));

    expect(screen.getByLabelText("Marca")).toHaveValue("VW");
    expect(screen.getAllByText("Atualizado pela placa").length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText("Marca"), "X");
    const warn = await screen.findByRole("dialog", { name: "Valor veio da placa" });
    expect(within(warn).getByText(/Confirme se está errado e verifique a placa também/)).toBeInTheDocument();
    await user.click(within(warn).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByLabelText("Marca")).toHaveValue("VW");
  }, 10_000);

  it("saves a sourced edit after the warning is confirmed and does not warn again", async () => {
    server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(foundBody)));
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Marca"), "Honda");
    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    const confirm = await screen.findByRole("dialog", { name: /Substituir dados pela placa ABC1D23/ });
    await user.click(within(confirm).getByRole("button", { name: "Substituir pelos dados da placa" }));

    await user.type(screen.getByLabelText("Marca"), "X");
    const warn = await screen.findByRole("dialog", { name: "Valor veio da placa" });
    await user.click(within(warn).getByRole("button", { name: "Continuar edição" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Valor veio da placa" })).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText("Marca")).toHaveValue("VWX");
    await user.type(screen.getByLabelText("Marca"), "Y");
    expect(screen.queryByRole("dialog", { name: "Valor veio da placa" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Marca")).toHaveValue("VWXY");
  }, 10_000);

  it("warns before retrying a remembered miss and spends nothing when declined", async () => {
    const lookups: Array<{ plate?: string; retry?: boolean }> = [];
    server.use(
      http.post("*/api/plate-lookups", async ({ request }) => {
        const body = (await request.json()) as { plate?: string; retry?: boolean };
        lookups.push(body);
        return HttpResponse.json({
          status: "not_found",
          source: "provider",
          provider: "agregados-propria",
          cached: true,
          lookedUpAt: "2026-09-01T15:00:00.000Z",
          recordedOutcome: "miss",
        });
      }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    await screen.findByText("A consulta não devolveu dados para esta placa.");
    await user.click(screen.getByRole("button", { name: "Consultar de novo" }));

    const retry = await screen.findByRole("dialog", { name: "Consultar a placa de novo?" });
    expect(within(retry).getByText(/sem dados utilizáveis/)).toBeInTheDocument();
    expect(within(retry).queryByText(/não existe/i)).not.toBeInTheDocument();
    await user.click(within(retry).getByRole("button", { name: "Cancelar" }));

    expect(lookups).toEqual([{ plate: "ABC1D23" }]);
  }, 10_000);

  it("retries a remembered miss when the attendant confirms", async () => {
    const lookups: Array<{ plate?: string; retry?: boolean }> = [];
    server.use(
      http.post("*/api/plate-lookups", async ({ request }) => {
        const body = (await request.json()) as { plate?: string; retry?: boolean };
        lookups.push(body);
        return HttpResponse.json({
          status: "not_found",
          source: "provider",
          provider: "agregados-propria",
          cached: true,
          lookedUpAt: "2026-09-01T15:00:00.000Z",
          recordedOutcome: "miss",
        });
      }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Placa"), "ABC1D23");
    await user.tab();
    await screen.findByText("A consulta não devolveu dados para esta placa.");
    await user.click(screen.getByRole("button", { name: "Consultar de novo" }));
    const retry = await screen.findByRole("dialog", { name: "Consultar a placa de novo?" });
    await user.click(within(retry).getByRole("button", { name: "Consultar de novo" }));

    await waitFor(() => {
      expect(lookups).toEqual([{ plate: "ABC1D23" }, { plate: "ABC1D23", retry: true }]);
    });
  }, 10_000);
});

describe("rail plate blur on a stored plate", () => {
  it("does not look up when the editor blurs the plate already stored", async () => {
    const lookups: unknown[] = [];
    const conv: ConversationSummary = {
      id: "conv-1",
      contactLabel: "Roberto",
      phone: "11988887777",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "UNKNOWN",
      unanswered: false,
      pipelineStage: "novosContatos",
    };
    const vehicle: Vehicle = {
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
      plateSourcedKeys: ["make"],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ customerId: "cus-1", vehicles: [vehicle] }),
      ),
      http.post("*/api/plate-lookups", async ({ request }) => {
        lookups.push(await request.json());
        return HttpResponse.json({ status: "unavailable" });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <MemoryRouter>
        <AppProviders queryClient={queryClient}>
          <ConversasPage />
        </AppProviders>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: "Editar veículo" }));
    await user.click(screen.getByLabelText("Placa"));
    await user.tab();

    expect(lookups).toHaveLength(0);
    expect(screen.getByText("Valor da placa ABC1D23")).toBeInTheDocument();
    expect(screen.getByLabelText("Modelo").closest(".MuiFormControl-root")).not.toHaveTextContent(
      "Valor da placa",
    );
  }, 10_000);
});
