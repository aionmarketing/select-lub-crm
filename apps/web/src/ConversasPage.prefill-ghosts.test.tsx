/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: prefill-ghosts-and-badge conversas + assistive-prefill deltas —
 * ghosts (not the old suggestion card), badge beside Editar hidden at
 * zero, rail accept immediate, Confirmar tudo + save calls accept-all,
 * save-without-confirmar-tudo does not, Recusar decrements.
 *
 * Task 7.1 moves the suggestions ONTO the fields: an occupied field carries a
 * marker that discloses the proposal beside the saved value, an empty field
 * shows the proposal directly, both accept and reject work without entering
 * the edit form, Confirmar tudo stays inside that form, and a suggested
 * vehicle ADDITION is one ghost row among the saved cars.
 *
 * Suggested vehicle REMOVALS are not covered because they do not exist:
 * `prefillFieldsSchema` carries scalar field values only, so nothing can
 * propose one. Deferred with the coordinator on 2026-09-05 rather than
 * inventing a contract from the rail.
 *
 * Axes
 *   A1 pending count — 0 / 1 / 2
 *   A2 surface — read-only field vs edit view
 *   A3 save — Salvar vs abandon
 *   A4 edit field — empty ghost vs filled correction
 *   A5 read-mode field — empty (value shown) vs occupied (marker + disclosure)
 *   A6 suggestion subject — person field vs vehicle addition
 *
 * Sampled-cell
 *   vehicle ghost row       | A1 1 A6 vehicle  | italic row + sugerido + accept  | old suggestion card
 *   accept the vehicle      | A6 vehicle       | one accept POST per field       | a single plate POST
 *   empty field in read     | A5 empty         | value shown + accept, no edit form | marker only
 *   occupied field in read  | A5 occupied      | saved value, marker, then disclosure + reject | proposal shown as the record
 *   badge at 0              | A1 0             | no badge 0                      | shows 0
 *   Confirmar tudo + save   | A3 save          | accept-all once                 | N accepts
 *   Confirmar tudo no save  | A3 abandon       | no accept-all                   | posted
 *   empty taxId in edit     | A4 empty         | placeholder + Aceitar CPF/CNPJ  | no actions
 *   filled name correction  | A4 filled        | sugestão under field            | placeholder
 *   Aceitar + Salvar        | A3 save A4 empty | POST /prefill/accept            | nothing
 *   Aceitar without Salvar  | A3 abandon       | no accept POST                  | posted
 *   Recusar in edit         | A2 edit          | POST /prefill/reject            | stays pending
 *
 * Decision map (conversas/contact-rail.tsx + conversas/prefill.tsx)
 *   D1 pendingCount === 0     T: empty; F: plate / two fields
 *   D2 confirmarTudo on save  T: accept-all; F: abandon
 *   D3 editAccepted on save   T: per-field accept; F: abandon
 *   D4 empty vs filled field  T: placeholder ghost; F: under-field correction
 *   D5 FieldSuggestion occupied T: marker + disclosure; F: value shown directly
 *   D6 disclosed             T: proposal + actions visible; F: marker alone
 *   D7 suggestedVehicleKeys non-empty T: ghost row; F: the person-only cases
 *
 * Out of scope: Playwright; Notion/GitHub wrap-up; extraction engine.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { customerFixture, type ConversationSummary, type Customer } from "@select-lub/shared-types";
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

const linked: Customer = {
  ...customerFixture,
  name: "Maria Silva",
  omieId: null,
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

describe("Conversas prefill ghosts", () => {
  it("renders a suggested vehicle as a ghost row among the saved ones, with a badge of 1", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ customerId: linked.id, vehicles: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { plate: "ABC1D23" }, extractEnabled: false }),
      ),
    );
    renderConversas();
    await userEvent.setup().click(await screen.findByText("11988887777"));

    const ghost = await screen.findByTestId("conversas-veiculo-sugerido");
    expect(ghost).toHaveTextContent("ABC1D23");
    expect(ghost).toHaveStyle({ fontStyle: "italic" });
    expect(screen.getByText("sugerido")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aceitar veículo sugerido" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    const badge = screen.getByRole("button", { name: "Editar" }).closest(".MuiBadge-root")
      ?.querySelector(".MuiBadge-badge");
    expect(badge).toHaveTextContent("1");
    // The old standalone suggestion card is gone; suggestions live on the
    // thing they are about.
    expect(screen.queryByLabelText("Sugestões de cadastro")).not.toBeInTheDocument();
  });

  it("accepts a suggested vehicle as one row, posting every suggested field", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const accepts: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ customerId: linked.id, vehicles: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({
          status: "pending",
          fields: { make: "Fiat", model: "Toro", year: 2022, plate: "QRS4T56" },
          extractEnabled: false,
        }),
      ),
      http.post("*/api/conversations/:id/prefill/accept", async ({ request }) => {
        accepts.push(await request.json());
        return HttpResponse.json({ status: "pending", fields: {}, extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));

    expect(await screen.findByTestId("conversas-veiculo-sugerido")).toHaveTextContent(
      "Fiat Toro 2022 · QRS4T56",
    );
    await user.click(screen.getByRole("button", { name: "Aceitar veículo sugerido" }));

    await waitFor(() => {
      expect(accepts).toHaveLength(4);
    });
    expect(accepts).toEqual([
      { field: "make", value: "Fiat" },
      { field: "model", value: "Toro" },
      { field: "year", value: 2022 },
      { field: "plate", value: "QRS4T56" },
    ]);
  });

  it("shows the proposed value on an empty field and accepts it without entering edit mode", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const accepts: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "12345678900" }, extractEnabled: false }),
      ),
      http.post("*/api/conversations/:id/prefill/accept", async ({ request }) => {
        accepts.push(await request.json());
        return HttpResponse.json({ status: "pending", fields: {}, extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));

    // taxId is null on the fixture, so the proposal is shown directly — there
    // is no saved value it could be mistaken for.
    const proposed = await screen.findByText("12345678900");
    expect(proposed).toHaveStyle({ fontStyle: "italic" });
    await user.click(screen.getByRole("button", { name: "Aceitar CPF/CNPJ" }));

    await waitFor(() => {
      expect(accepts).toEqual([{ field: "taxId", value: "12345678900" }]);
    });
    // Never entered the edit form, and Confirmar tudo stays inside it.
    expect(screen.queryByRole("button", { name: "Confirmar tudo" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversas-cadastro-name")).not.toBeInTheDocument();
  });

  it("keeps an occupied field's saved value on screen until the suggestion is disclosed", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const rejects: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: { ...linked, taxId: "12345678900" }, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "12345678909" }, extractEnabled: false }),
      ),
      http.post("*/api/conversations/:id/prefill/reject", async ({ request }) => {
        rejects.push(await request.json());
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));

    // The saved value is on screen; the proposal is behind a marker, so a
    // proposal can never be read as the record.
    expect(await screen.findByText("CPF/CNPJ: 12345678900")).toBeInTheDocument();
    expect(screen.queryByText("sugerido: 12345678909")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ver a sugestão para CPF/CNPJ" }));

    expect(await screen.findByText("sugerido: 12345678909")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recusar CPF/CNPJ" }));

    await waitFor(() => {
      expect(rejects).toEqual([{ field: "taxId" }]);
    });
  });

  it("hides the Editar badge when no suggestions are pending", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () => HttpResponse.json({ status: "empty", extractEnabled: false })),
    );
    renderConversas();
    await userEvent.setup().click(await screen.findByText("11988887777"));

    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.queryByText("sugestão")).not.toBeInTheDocument();
    const editar = screen.getByRole("button", { name: "Editar" });
    expect(within(editar.parentElement ?? editar).queryByText("0")).not.toBeInTheDocument();
  });

  it("opens the edit view from the Editar control that carries the badge", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { name: "Ana Souza", plate: "ABC1D23" }, extractEnabled: false }),
      ),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));

    expect(await screen.findByLabelText("Nome")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar tudo" })).toBeInTheDocument();
  });

  it("posts accept-all once when Confirmar tudo is pressed and the form is saved", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const acceptAll: string[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { name: "Ana Souza", plate: "ABC1D23" }, extractEnabled: false }),
      ),
      http.patch("*/api/customers/:id", async () => HttpResponse.json(linked)),
      http.post("*/api/conversations/:id/prefill/accept-all", () => {
        acceptAll.push("all");
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar tudo" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(acceptAll).toEqual(["all"]);
    });
  });

  it("does not post accept-all when Confirmar tudo is pressed but the form is not saved", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const acceptAll: string[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { plate: "ABC1D23" }, extractEnabled: false }),
      ),
      http.post("*/api/conversations/:id/prefill/accept-all", () => {
        acceptAll.push("all");
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar tudo" }));

    expect(acceptAll).toEqual([]);
  });

  it("shows an empty-field ghost inside the edit view with accept and Recusar", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "123.456.789-00" }, extractEnabled: false }),
      ),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));

    expect(await screen.findByLabelText("CPF/CNPJ")).toHaveAttribute(
      "placeholder",
      "123.456.789-00",
    );
    expect(screen.getByText("Aceitar CPF/CNPJ")).toBeInTheDocument();
    expect(screen.getByText("Recusar CPF/CNPJ")).toBeInTheDocument();
  });

  it("shows a filled-field correction under the field in the edit view", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { name: "Ana Souza" }, extractEnabled: false }),
      ),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));

    expect(await screen.findByText("sugestão: Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Aceitar Nome")).toBeInTheDocument();
    expect(screen.getByText("Recusar Nome")).toBeInTheDocument();
  });

  it("posts per-field accept on save after Aceitar in the edit view", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const acceptPosts: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "123.456.789-00" }, extractEnabled: false }),
      ),
      http.patch("*/api/customers/:id", async () => HttpResponse.json({ ...linked, taxId: "123.456.789-00" })),
      http.post("*/api/conversations/:id/prefill/accept", async ({ request }) => {
        acceptPosts.push(await request.json());
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByText("Aceitar CPF/CNPJ"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(acceptPosts).toEqual([{ field: "taxId", value: "123.456.789-00" }]);
    });
  });

  it("does not post accept when Aceitar is pressed in edit but the form is not saved", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const acceptPosts: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "123.456.789-00" }, extractEnabled: false }),
      ),
      http.post("*/api/conversations/:id/prefill/accept", async ({ request }) => {
        acceptPosts.push(await request.json());
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByText("Aceitar CPF/CNPJ"));

    expect(acceptPosts).toEqual([]);
  });

  it("posts reject immediately when Recusar is pressed in the edit view", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    const rejectPosts: unknown[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/customer", () =>
        HttpResponse.json({ customer: linked, pendings: [] }),
      ),
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { taxId: "123.456.789-00" }, extractEnabled: false }),
      ),
      http.post("*/api/conversations/:id/prefill/reject", async ({ request }) => {
        rejectPosts.push(await request.json());
        return HttpResponse.json({ status: "empty", extractEnabled: false });
      }),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    await user.click(screen.getByText("Recusar CPF/CNPJ"));

    await waitFor(() => {
      expect(rejectPosts).toEqual([{ field: "taxId" }]);
    });
  });
});
