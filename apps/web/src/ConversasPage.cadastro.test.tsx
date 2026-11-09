/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: cadastro-panel-conflict-ui conversas delta — click-to-edit
 * Contato, inline pending warning independent of Editar, resolve
 * CRM/Omie/edit, 503 keeps local name, PATCH /vehicles/:id, global
 * pendências badge absent at zero.
 *
 * Axes
 *   A1 customer GET — null / fixture / 500
 *   A2 edit toggle — read-only / inputs
 *   A3 save — PATCH existing / POST create / 503 / unlinked 200
 *   A4 pending — warning in both modes; Omie choice closes
 *   A5 badge — 0 absent count / ≥1 grouped / Abrir conversa
 *   A6 vehicle PATCH
 *   A7 panel conflicts — 1 field (singular count) vs 2 (plural)
 *   A8 diff shape — both sides differ (postalCode) vs an insertion the CRM
 *      side is wholly contained in (primaryEmail)
 *
 * Panel oracle (7.3): the pendências drawer is a per-field merge — both
 * values shown with the differing run marked, per-field Usar CRM / Usar Omie /
 * Editar, a count of what is unresolved, and nothing pre-selected or offered
 * in bulk.
 *
 * Sampled-cell
 *   empty unlinked          | A1 null     | empty copy + Editar | invented name
 *   linked read-only        | A1 fixture  | name text not input | textbox Nome
 *   Editar reveals inputs   | A2          | textbox Nome        | stays read-only
 *   save PATCH              | A3 PATCH    | PATCH body name     | POST create
 *   create on save          | A3 POST     | POST /customer      | PATCH
 *   unlinked no 409 copy    | A3 200      | no "409"            | 409 text
 *   warning read-only+edit  | A4          | warning both        | only in edit
 *   choose Omie             | A4          | postalCode Omie val | stays CRM
 *   503 keeps name          | A3 503      | banner + Maria      | cleared
 *   nameless shows phone    | A1 name null| phone not Omie/Sem nome | invented label
 *   badge zero              | A5 0        | no count "0"        | shows 0
 *   badge two customers     | A5 ≥1       | grouped names       | flat ungrouped
 *   Abrir conversa          | A5 link     | selects row         | stays closed
 *   vehicle PATCH           | A6          | PATCH /vehicles     | PATCH /customers plate
 *   panel diff, 2 fields    | A7 2, A8 both | marked runs + plural count + no preselection | flat CRM/Omie text
 *   panel resolve           | A7 1        | singular count, resolve POST, list empties | leaves the panel
 *
 * Decision map (conversas/contact-rail.tsx + conversas/prefill.tsx +
 * ConversasPage.tsx badge)
 *   pendingCount === 0 T: badge zero it; F: badge two + Abrir conversa
 *   editingContato T: Editar inputs; F: read-only
 *   customer null T: empty unlinked / create POST; F: linked PATCH
 *   rows.length === 1 T: singular count copy; F: plural count copy
 *   groups.length === 0 T: "Nenhuma pendência aberta" after the resolve; F: groups
 *   diffSegments marked empty T: the CRM email side; F: every other side here
 *
 * Out of scope: Playwright; givenName/familyName in the form (dropped
 * 2026-08-29); versions on pending rows (not in the HTTP DTO).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  customerFixture,
  type ConversationSummary,
  type Customer,
  type GlobalReconciliationPending,
  type ReconciliationPending,
  type Vehicle,
} from "@select-lub/shared-types";
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
    // Default for these fixtures, which carry no outbound message; `partial`
    // still overrides it for a case that wants a further stage.
    pipelineStage: "novosContatos",
    ...partial,
  };
}

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

const linked: Customer = {
  ...customerFixture,
  name: "Maria Silva",
  omieId: null,
  taxId: "12345678900",
  postalCode: "01310100",
};

const postalPending: ReconciliationPending = {
  fieldKey: "postalCode",
  crmValue: "01310100",
  omieValue: "13035000",
  status: "open",
  customerId: linked.id,
  vehicleId: null,
};

const vehicleRow: Vehicle = {
  id: "veh-1",
  customerId: linked.id,
  omieId: null,
  plate: "ABC1D23",
  make: null,
  model: null,
  version: null,
  year: null,
  odometerKm: null,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Conversas cadastro rail", () => {
  it("shows Portuguese empty cadastro without inventing person fields", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(http.get("*/api/conversations", () => HttpResponse.json([conv])));
    renderConversas();
    await userEvent.setup().click(await screen.findByText("11988887777"));

    expect(
      await screen.findByText('Preencha o cadastro em "Editar" para criar e vincular o cliente'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.queryByText("Maria Silva")).not.toBeInTheDocument();
    expect(screen.queryByText("12345678900")).not.toBeInTheDocument();
  });

  it("shows the conversation phone when the linked customer name is null", async () => {
    const conv = summary({
      id: "conv-1",
      phone: "5511999990000",
      contactLabel: "5511999990000",
    });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: { ...linked, name: null }, pendings: [] }),
      ),
    );
    renderConversas();
    await userEvent.setup().click(await screen.findByText("5511999990000"));

    expect(screen.getAllByText("5511999990000").length).toBeGreaterThan(0);
    expect(screen.queryByText("Omie")).not.toBeInTheDocument();
    expect(screen.queryByText("Sem nome")).not.toBeInTheDocument();
    expect(screen.queryByText("Maria Silva")).not.toBeInTheDocument();
  });

  it("renders linked fields as read-only text until Editar is clicked", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));

    expect(await screen.findByText("Maria Silva")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(await screen.findByLabelText("Nome")).toHaveValue("Maria Silva");
  });

  it("PATCHes the linked customer on Salvar and does not show 409 copy when unlinked", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const patches: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.patch("*/api/customers/:id", async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ ...linked, name: "Maria Souza" });
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.clear(screen.getByLabelText("Nome"));
    await user.type(screen.getByLabelText("Nome"), "Maria Souza");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(patches).toEqual([expect.objectContaining({ name: "Maria Souza" })]);
    });
    expect(screen.queryByText(/409/)).not.toBeInTheDocument();
  });

  it("creates a customer with POST when the conversation has none yet", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const creates: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.post("*/api/conversations/:id/customer", async ({ request }) => {
        creates.push(await request.json());
        return HttpResponse.json({ ...linked, name: "Ana Nova" }, { status: 201 });
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.type(screen.getByLabelText("Nome"), "Ana Nova");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(creates).toEqual([expect.objectContaining({ name: "Ana Nova" })]);
    });
  });

  it("shows a pending warning in read-only and edit modes", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [postalPending] }),
      ),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));

    expect(
      await screen.findByText("CEP tem uma pendência de conflito com o Omie"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.getByText("CEP tem uma pendência de conflito com o Omie")).toBeInTheDocument();
  });

  it("keeps an open postalCode pending until Omie is chosen, then shows the Omie value", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    let open = true;
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({
          customer: open ? linked : { ...linked, postalCode: "13035000" },
          pendings: open ? [postalPending] : [],
        }),
      ),
      http.post("*/api/customers/:id/reconciliation-pendings/resolve", async ({ request }) => {
        const body = (await request.json()) as { choice: string };
        expect(body.choice).toBe("omie");
        open = false;
        return HttpResponse.json({ ...linked, postalCode: "13035000" });
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    expect(await screen.findByText(/CEP: 01310100/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usar Omie" }));

    await waitFor(() => {
      expect(screen.getByText(/CEP: 13035000/)).toBeInTheDocument();
    });
    expect(screen.queryByText("CEP tem uma pendência de conflito com o Omie")).not.toBeInTheDocument();
  });

  it("shows Omie unavailable copy and keeps the local name after a 503 save", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const linkedOmie = { ...linked, omieId: "omie-1" };
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linkedOmie, pendings: [] }),
      ),
      http.patch("*/api/customers/:id", () =>
        HttpResponse.json(linkedOmie, { status: 503 }),
      ),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(
      await screen.findByText("Omie indisponível. Os dados locais foram mantidos."),
    ).toBeInTheDocument();
    expect(screen.getByText("Maria Silva")).toBeInTheDocument();
  });

  it("PATCHes a listed vehicle through /vehicles/:id", async () => {
    const user = userEvent.setup();
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const patches: string[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ customerId: linked.id, vehicles: [vehicleRow] }),
      ),
      http.patch("*/api/vehicles/:id", ({ request }) => {
        patches.push(new URL(request.url).pathname);
        return HttpResponse.json({ ...vehicleRow, plate: "XYZ9F88" });
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar veículo" }));
    await user.clear(screen.getByLabelText("Placa"));
    await user.type(screen.getByLabelText("Placa"), "XYZ9F88");
    await user.click(screen.getByRole("button", { name: "Salvar veículo" }));

    await waitFor(() => {
      expect(patches.some((path) => path.includes("/vehicles/veh-1"))).toBe(true);
    });
  });

  it("hides the pendências count at zero and lists grouped rows when count is at least 2", async () => {
    const user = userEvent.setup();
    const convA = summary({ id: "conv-a", phone: "111", contactLabel: "Ana" });
    const convB = summary({ id: "conv-b", phone: "222", contactLabel: "Bia" });
    const rows: GlobalReconciliationPending[] = [
      {
        ...postalPending,
        customerId: "cus-a",
        customerName: "Ana",
        fieldKey: "postalCode",
      },
      {
        fieldKey: "name",
        crmValue: "Bia",
        omieValue: "BIA LTDA",
        status: "open",
        customerId: "cus-b",
        vehicleId: null,
        customerName: "Bia",
      },
    ];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([convA, convB])),
      http.get("*/api/reconciliation-pendings", () => HttpResponse.json(rows)),
    );
    renderConversas();

    expect(await screen.findByLabelText("Pendências com o Omie, 2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pendências com o Omie, 0")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Pendências com o Omie, 2"));
    expect(
      await screen.findByRole("heading", { name: "Pendências com o Omie — todos os clientes" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Ana").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Bia").length).toBeGreaterThan(1);

    const openButtons = screen.getAllByRole("button", { name: "Abrir conversa" });
    await user.click(openButtons[1]!);
    await waitFor(() => {
      expect(screen.getAllByText("222").length).toBeGreaterThan(1);
    });
  });

  it("marks the differing portion per field, counts what is unresolved, and preselects nothing", async () => {
    const user = userEvent.setup();
    const convA = summary({ id: "conv-a", phone: "111", contactLabel: "Ana" });
    const rows: GlobalReconciliationPending[] = [
      { ...postalPending, customerId: "cus-a", customerName: "Ana", fieldKey: "postalCode" },
      {
        fieldKey: "primaryEmail",
        crmValue: "roberto.a@example.com",
        omieValue: "roberto.aparecido@example.com",
        status: "open",
        customerId: "cus-a",
        vehicleId: null,
        customerName: "Ana",
      },
    ];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([convA])),
      http.get("*/api/reconciliation-pendings", () => HttpResponse.json(rows)),
    );
    renderConversas();
    await user.click(await screen.findByLabelText("Pendências com o Omie, 2"));

    // The drawer paper carries the panel's aria-label, so scoping here keeps
    // the inbox row for Ana out of the assertions below.
    const drawer = await screen.findByLabelText("Pendências com o Omie — todos os clientes");
    expect(within(drawer).getByText("2 campos ainda sem resolução")).toBeInTheDocument();
    // 01310100 against 13035000 shares only the trailing "00", so each side
    // marks the leading six digits and neither marks the shared tail.
    expect(within(drawer).getByText("013101")).toBeInTheDocument();
    expect(within(drawer).getByText("130350")).toBeInTheDocument();
    // An insertion: the CRM address is entirely contained in the Omie one, so
    // only the Omie side carries a marked run.
    expect(within(drawer).getByText("parecido")).toBeInTheDocument();

    // Per field, all three choices are offered and none of them is taken.
    expect(within(drawer).getAllByRole("button", { name: "Usar CRM" })).toHaveLength(2);
    expect(within(drawer).getAllByRole("button", { name: "Usar Omie" })).toHaveLength(2);
    expect(within(drawer).getAllByRole("button", { name: "Editar valor" })).toHaveLength(2);
    for (const button of within(drawer).getAllByRole("button")) {
      expect(button).not.toHaveAttribute("aria-pressed", "true");
    }
    expect(within(drawer).queryByRole("button", { name: /todos/i })).not.toBeInTheDocument();
  });

  it("resolves one field from the panel without leaving it", async () => {
    const user = userEvent.setup();
    const convA = summary({ id: "conv-a", phone: "111", contactLabel: "Ana" });
    let rows: GlobalReconciliationPending[] = [
      { ...postalPending, customerId: "cus-a", customerName: "Ana", fieldKey: "postalCode" },
    ];
    const resolves: Array<{ customerId: string; body: unknown }> = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([convA])),
      http.get("*/api/reconciliation-pendings", () => HttpResponse.json(rows)),
      http.post("*/api/customers/:id/reconciliation-pendings/resolve", async ({ params, request }) => {
        resolves.push({ customerId: String(params.id), body: await request.json() });
        rows = [];
        return HttpResponse.json({ ...linked, postalCode: "13035000" });
      }),
    );
    renderConversas();
    await user.click(await screen.findByLabelText("Pendências com o Omie, 1"));

    expect(await screen.findByText("1 campo ainda sem resolução")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usar Omie" }));

    await waitFor(() => {
      expect(resolves).toHaveLength(1);
    });
    expect(resolves[0]).toEqual({
      customerId: "cus-a",
      body: { choice: "omie", fieldKey: "postalCode", vehicleId: null },
    });
    expect(await screen.findByText("Nenhuma pendência aberta")).toBeInTheDocument();
  });

  it("does not show a zero count on the pendências badge", async () => {
    server.use(http.get("*/api/conversations", () => HttpResponse.json([])));
    renderConversas();

    expect(await screen.findByLabelText("Pendências com o Omie")).toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
  });
});
