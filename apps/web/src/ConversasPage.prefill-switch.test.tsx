/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: prefill-switch-realistic-workshop-mix conversas delta — stack view
 * shows MUI switch **Sugerir dados do cliente** last, default off, persist
 * per conversation, Portuguese error reverts, no cadastro write, absent from
 * vehicle drill-in.
 *
 * Grounding (ui-spec-to-code): list-detail inspector rail. Sibling read:
 * ConversasPage unanswered FormControlLabel+Switch and contact-rail stack
 * (Contato → Tags → Veículos → Serviços → Mensagens programadas). One
 * primary CTA stays Editar/Salvar; the switch is a setting. Caption helper
 * under the label. Own section at the bottom of the stack.
 *
 * Axes
 *   A1 extractEnabled persisted — false (default) / true
 *   A2 conversation identity — first vs second
 *   A3 PATCH outcome — 200 / 500
 *   A4 railView — stack vs veiculo drill-in
 *
 * Outputs
 *   O1 switch off, last in stack
 *   O2 first conv on, second still off
 *   O3 Portuguese error + reverted switch
 *   O4 no PATCH /customers
 *   O5 switch absent in drill-in
 *
 * Sampled-cell
 *   default off last in stack     | A1 false A4 stack | O1 | on, or above programadas
 *   toggle persists per conv      | A1 A2             | O2 | second inherits on
 *   persist error reverts         | A3 500            | O3 | stays on, English error
 *   turning on does not write     | A3 200            | O4 | PATCH customer
 *   drill-in omits switch         | A4 veiculo        | O5 | switch still in document
 *
 * Decision map (contact-rail.tsx)
 *   D1 railView === stack         T: switch its; F: drill-in it
 *   D2 extractEnabledMutation.isError T: error it; F: default/toggle its
 *   D3 onMutate optimistic         T: toggle it (checked before PATCH settles)
 *   D4 onError restore             T: error it; F: 200 persist it
 *
 * Out of scope: worker enqueue; HTTP 404 other unit (API inject).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  customerFixture,
  type ConversationSummary,
  type Customer,
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
    pipelineStage: "novosContatos",
    ...partial,
  };
}

const linked: Customer = { ...customerFixture, name: "Maria Silva" };

const vehicleRow: Vehicle = {
  id: "veh-1",
  customerId: linked.id,
  omieId: null,
  plate: "ABC1D23",
  make: "Toyota",
  model: "Corolla",
  version: "1.8",
  year: 2019,
  odometerKm: null,
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

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

function stubSwitchRail(options?: {
  conversations?: ConversationSummary[];
  extractById?: Record<string, boolean>;
  patchStatus?: number;
  onPatch?: (body: { extractEnabled: boolean; conversationId: string }) => void;
  onCustomerPatch?: () => void;
  withVehicle?: boolean;
}) {
  const conversations = options?.conversations ?? [
    summary({ id: "conv-a", phone: "11988887777", contactLabel: "Ana" }),
  ];
  const extractById = { ...options?.extractById };
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json(conversations)),
    http.get("*/api/conversations/:id/customer", () =>
      HttpResponse.json({ customer: linked, pendings: [] }),
    ),
    http.get("*/api/conversations/:id/vehicles", () =>
      HttpResponse.json({
        customerId: linked.id,
        vehicles: options?.withVehicle ? [vehicleRow] : [],
      }),
    ),
    http.get("*/api/conversations/:id/services", () =>
      HttpResponse.json({ customerId: linked.id, services: [] }),
    ),
    http.get("*/api/vehicles/:id/services", () => HttpResponse.json([])),
    http.get("*/api/conversations/:id/prefill", ({ params }) => {
      const id = String(params.id);
      return HttpResponse.json({
        status: "empty",
        extractEnabled: extractById[id] ?? false,
      });
    }),
    http.patch("*/api/conversations/:id/prefill/extract-enabled", async ({ params, request }) => {
      if (options?.patchStatus === 500) {
        return HttpResponse.json({ error: "fail" }, { status: 500 });
      }
      const body = (await request.json()) as { extractEnabled: boolean };
      const conversationId = String(params.id);
      extractById[conversationId] = body.extractEnabled;
      options?.onPatch?.({ ...body, conversationId });
      return HttpResponse.json({ status: "empty", extractEnabled: body.extractEnabled });
    }),
    http.patch("*/api/customers/:id", () => {
      options?.onCustomerPatch?.();
      return HttpResponse.json(linked);
    }),
  );
}

describe("Conversas prefill extract switch", () => {
  it("shows the switch off as the last control below Mensagens programadas", async () => {
    stubSwitchRail();
    renderConversas();
    await userEvent.setup().click(await screen.findByText("Ana"));

    const control = await screen.findByRole("switch", { name: "Sugerir dados do cliente" });
    expect(control).not.toBeChecked();
    const programadas = screen.getByText("Mensagens programadas");
    expect(programadas.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the switch on for that conversation after opening another", async () => {
    const convA = summary({ id: "conv-a", phone: "11988887777", contactLabel: "Ana" });
    const convB = summary({ id: "conv-b", phone: "11977776666", contactLabel: "Bruno" });
    stubSwitchRail({ conversations: [convA, convB] });
    const user = userEvent.setup();
    renderConversas();

    await user.click(await screen.findByText("Ana"));
    await user.click(await screen.findByRole("switch", { name: "Sugerir dados do cliente" }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Sugerir dados do cliente" })).toBeChecked();
    });

    await user.click(screen.getByText("Bruno"));
    expect(await screen.findByRole("switch", { name: "Sugerir dados do cliente" })).not.toBeChecked();

    await user.click(screen.getByText("Ana"));
    expect(await screen.findByRole("switch", { name: "Sugerir dados do cliente" })).toBeChecked();
  });

  it("shows a Portuguese error and reverts when saving the switch fails", async () => {
    stubSwitchRail({ patchStatus: 500 });
    const user = userEvent.setup();
    renderConversas();
    await user.click(await screen.findByText("Ana"));
    await user.click(await screen.findByRole("switch", { name: "Sugerir dados do cliente" }));

    expect(await screen.findByText("Não foi possível salvar a opção de sugerir dados do cliente")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Sugerir dados do cliente" })).not.toBeChecked();
    });
  });

  it("does not write cadastro when the switch is turned on", async () => {
    const customerPatches: string[] = [];
    stubSwitchRail({ onCustomerPatch: () => customerPatches.push("customer") });
    const user = userEvent.setup();
    renderConversas();
    await user.click(await screen.findByText("Ana"));
    await user.click(await screen.findByRole("switch", { name: "Sugerir dados do cliente" }));

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Sugerir dados do cliente" })).toBeChecked();
    });
    expect(customerPatches).toEqual([]);
  });

  it("hides the switch on the vehicle drill-in", async () => {
    stubSwitchRail({ withVehicle: true });
    const user = userEvent.setup();
    renderConversas();
    await user.click(await screen.findByText("Ana"));
    expect(await screen.findByRole("switch", { name: "Sugerir dados do cliente" })).toBeInTheDocument();

  // Substring, not the exact plate: the two variants name this button
  // differently and both are correct. cursor's row shows the plate alone, so
  // its accessible name IS "ABC1D23"; antigravity's shows identity and plate
  // joined ("Toyota Corolla 1.8 XEi · ABC1D23"), which still satisfies WCAG
  // 2.5.3 because the visible text carries the plate. An exact-name query
  // passes on cursor and fails on antigravity against a button that is present
  // and clickable. No sibling button in the row contains a plate, so the
  // substring is unambiguous.
    await user.click(screen.getByRole("button", { name: /ABC1D23/ }));
    expect(await screen.findByRole("region", { name: "Veículo" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Sugerir dados do cliente" })).not.toBeInTheDocument();
  });
});
