/**
 * Test design (testing-strategy) — the quote dialog's interim guards (tasks 1.11, 1.12)
 *
 * Setup: ConversasPage in AppProviders, MSW. Unlike the other quote files, the QueryClient here
 *   keeps the production defaults this guard overrides — one retry and a refetch on window
 *   focus — so the query's own options are what is under test.
 *
 * Oracle: background-oil-research D2 and D17: the quote-options query sets `retry: false` and
 *   `refetchOnWindowFocus: false`, so neither a failed read nor a refocus re-sends it (under the
 *   long research-model limits one read can run a paid pipeline for minutes); a clarification renders D17's
 *   sentence for its coverage and engines, with no empty parentheses.
 *
 * Cells
 *   a read that fails          | one request, the error state | a retried request
 *   a refocus after an answer  | no second request            | a refetch
 *   clarification several + 2  | "cita mais de um motor para este veículo: A e B."
 *   clarification several + 0  | "não diz qual é o deste veículo", no "()"
 *   clarification mismatch + 1 | "descreve outro motor (1.6)."
 */
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Vehicle } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

const conversation: ConversationSummary = {
  id: "conv-1",
  phone: "11988887777",
  contactLabel: "Roberto",
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
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** Opens the quote dialog with `respond` answering quote-options; returns the request count. */
async function openQuote(respond: () => Response) {
  let reads = 0;
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([conversation])),
    http.get("*/api/conversations/:id/vehicles", () => HttpResponse.json({ customerId: "cus-1", vehicles: [vehicle] })),
    http.get("*/api/vehicles/:id/quote-options", () => {
      reads += 1;
      return respond();
    }),
  );
  // The production defaults the guard must override: one retry, refetch on focus.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0, refetchOnWindowFocus: true, refetchOnReconnect: true } } });
  render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ConversasPage />
      </AppProviders>
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText("Roberto"));
  await user.click(await screen.findByRole("button", { name: "Montar orçamento" }));
  return { reads: () => reads };
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("the quote-options read is sent once", () => {
  it("does not retry a failed read", async () => {
    const { reads } = await openQuote(() => HttpResponse.json({ error: "boom" }, { status: 500 }));

    expect(await screen.findByText("Não foi possível carregar as opções de orçamento")).toBeInTheDocument();
    expect(reads()).toBe(1);
  });

  it("does not refetch when the window regains focus", async () => {
    const { reads } = await openQuote(() => HttpResponse.json({ status: "no_spec", reason: "no_source" }));
    await screen.findByText(/Não encontramos o óleo indicado/);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reads()).toBe(1);
  });
});

describe("a reconnect", () => {
  it("does not refetch the read when the network comes back", async () => {
    const { reads } = await openQuote(() => HttpResponse.json({ status: "no_spec", reason: "no_source" }));
    await screen.findByText(/Não encontramos o óleo indicado/);

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reads()).toBe(1);
  });
});

describe("a clarification", () => {
  it.each([
    [{ coverage: "several", options: ["1.8 XEi", "2.0 XEi"] }, "A fonte cita mais de um motor para este veículo: 1.8 XEi e 2.0 XEi. Confira a versão do veículo."],
    [{ coverage: "several", options: [] }, "A fonte cita mais de um motor e não diz qual é o deste veículo. Confira a versão do veículo."],
    [{ coverage: "mismatch", options: ["1.6"] }, "A fonte encontrada descreve outro motor (1.6). Confira a versão do veículo."],
  ])("renders %j as its sentence", async (payload, sentence) => {
    await openQuote(() => HttpResponse.json({ status: "needs_clarification", ...payload }));

    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(/\(\)/)).not.toBeInTheDocument();
  });
});
