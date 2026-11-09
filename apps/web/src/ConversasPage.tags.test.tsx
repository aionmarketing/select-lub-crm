/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: conversas delta + tags-templates Axis 5 — apply POST; filter
 * reduces rows. Template insert into the composer left the MVP
 * (`remove-rail-templates`, 2026-08-31): the
 * former "fills the composer from preview" case is deleted with that
 * requirement, not skipped.
 *
 * Axes
 *   A1 apply control — POST /conversations/:id/tags/:tagId
 *   A2 list filter — one tagId query keeps matching row
 *
 * Outputs
 *   O1 apply POST happened
 *   O2 list row count 2 → 1
 *   O3 rail has no Templates heading; GET /templates never fires
 *
 * Sampled-cell
 *   apply Retorno     | A1 | O1 | GET only
 *   filter T1         | A2 | O2 | both rows remain
 *   open conversation | — | O3 | GET /templates
 *
 * Decision map (conversas/inbox.tsx TagFilter; conversas/contact-rail.tsx apply)
 *   D1 filterTagIds.length T: filter it; F: unfiltered two-row list
 *   D2 applyTag.mutate T: apply it; F: other tests do not click Aplicar
 *   D3 insertTemplate.mutate — N/A (control removed; O3 asserts absence)
 *
 * Out of scope: Configurações CRUD (ConfiguracoesPage.test.tsx); Playwright.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Tag, Template } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

const tagRetorno: Tag = {
  id: "tag-1",
  name: "Retorno",
  color: "primary",
  sortOrder: 0,
  active: true,
};

const templateOi: Template = {
  id: "tpl-1",
  name: "Saudacao",
  text: "Ola {{nome_cliente}}",
  allowedVariables: ["nome_cliente"],
  status: "active",
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function summary(partial: Partial<ConversationSummary> & Pick<ConversationSummary, "id" | "phone">): ConversationSummary {
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

describe("Conversas tags and templates", () => {
  it("POSTs apply when the attendant applies a tag on the open conversation", async () => {
    const user = userEvent.setup();
    const applyUrls: string[] = [];
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/tags/apply-options", () => HttpResponse.json([tagRetorno])),
      http.post("*/api/conversations/:id/tags/:tagId", ({ request }) => {
        applyUrls.push(new URL(request.url).pathname);
        return HttpResponse.json({});
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    await user.click(await screen.findByRole("button", { name: "Aplicar Retorno" }));

    await waitFor(() => {
      expect(applyUrls.some((path) => path.includes("/conversations/conv-1/tags/tag-1"))).toBe(true);
    });
  });

  it("reduces the list when a tag filter is selected", async () => {
    const user = userEvent.setup();
    const convA = summary({ id: "conv-a", phone: "111" });
    const convB = summary({ id: "conv-b", phone: "222" });
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        const tagId = new URL(request.url).searchParams.getAll("tagId");
        if (tagId.includes("tag-1")) {
          return HttpResponse.json([convA]);
        }
        return HttpResponse.json([convA, convB]);
      }),
      http.get("*/api/tags/apply-options", () => HttpResponse.json([tagRetorno])),
    );
    renderConversas();
    expect(await screen.findByText("111")).toBeInTheDocument();
    expect(screen.getByText("222")).toBeInTheDocument();

    await user.click(screen.getByText("Retorno"));

    await waitFor(() => {
      expect(screen.queryByText("222")).not.toBeInTheDocument();
    });
    expect(screen.getByText("111")).toBeInTheDocument();

    // align-shipped-ui-to-canvas F4: the "Todas" chip clears the filter.
    await user.click(screen.getByText("Todas"));
    await waitFor(() => {
      expect(screen.getByText("222")).toBeInTheDocument();
    });
  });

  it("does not fetch templates or show an Inserir control on Conversas", async () => {
    const user = userEvent.setup();
    const templateGets: string[] = [];
    const conv = summary({ id: "conv-1", phone: "11988887777" });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/templates", ({ request }) => {
        templateGets.push(new URL(request.url).pathname);
        return HttpResponse.json([templateOi]);
      }),
    );
    renderConversas();
    await user.click(await screen.findByText("11988887777"));
    expect(await screen.findByText("Contato")).toBeInTheDocument();

    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Inserir/ })).not.toBeInTheDocument();
    expect(templateGets).toEqual([]);
  });
});
