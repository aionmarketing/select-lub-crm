/**
 * Test design (testing-strategy)
 *
 * Setup: renders Conversas through AppProviders with MSW standing in for the
 * rail's four reads, and opens the first conversation. Antigravity-only: every
 * case is skipped in the default mode, because the cursor rail draws stacked
 * sections with no per-section retry.
 *
 * Oracle: openspec/changes/build-time-ui-variant specs/conversas —
 * "Antigravity contact rail lists are cards that can retry": each section shows
 * its own loading text, and a failed section offers a retry that re-issues that
 * section's request.
 *
 * Axes
 *   A1 section — veículos / serviços / mensagens programadas
 *   A2 request state — in flight / failed / failed then succeeding
 *
 * Outputs
 *   O1 the section's own loading text, naming that section
 *   O2 a retry action on the failed section
 *   O3 the request goes out again and the list replaces the error
 *
 * Sampled-cell
 *   scheduled in flight  | A1 schedule | A2 pending | O1 | one shared spinner
 *   vehicles failed      | A1 vehicles | A2 error   | O2 | a dead end
 *   vehicles retried     | A1 vehicles | A2 recover | O3 | retry that refetches nothing
 *
 * Limits (boundary value analysis):
 *   The retry asserts a SECOND request and the error clearing, not just a click
 *   handler firing: a button wired to a no-op refetch would pass the weaker
 *   check while leaving the attendant stuck.
 *
 * What would make a test fail:
 *   Collapsing the three sections onto one loading state or one retry; a retry
 *   that re-renders without re-issuing the request.
 *
 * Production decisions: none. This suite drives rendered rail chrome.
 *
 * Not in this file: the rail's cadastro form and drill-ins (shared with cursor,
 * covered by ConversasPage.cadastro / drill-ins suites in both modes); the icon
 * rail and page shell (shell.antigravity.test.tsx).
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationSummary } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { UI_VARIANT } from "./uiVariant.js";
import { server } from "../test/msw/server.js";

const onAntigravity = UI_VARIANT === "antigravity" ? describe : describe.skip;

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

/** Counts calls per rail read so a retry can be observed as a second request. */
function stubRail(options: {
  vehicles?: "ok" | "error";
  services?: "ok" | "error";
  scheduled?: "ok" | "error" | "pending";
}) {
  const calls = { vehicles: 0, services: 0, scheduled: 0 };
  let vehiclesMode = options.vehicles ?? "ok";
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([conversation])),
    http.get("*/api/conversations/:id/vehicles", () => {
      calls.vehicles += 1;
      return vehiclesMode === "error"
        ? HttpResponse.json({ error: "boom" }, { status: 500 })
        : HttpResponse.json({ customerId: "cus-1", vehicles: [] });
    }),
    http.get("*/api/conversations/:id/services", () => {
      calls.services += 1;
      return (options.services ?? "ok") === "error"
        ? HttpResponse.json({ error: "boom" }, { status: 500 })
        : HttpResponse.json({ customerId: "cus-1", services: [] });
    }),
    http.get("*/api/conversations/:id/scheduled-messages", async () => {
      calls.scheduled += 1;
      if (options.scheduled === "pending") {
        await new Promise(() => {});
      }
      return (options.scheduled ?? "ok") === "error"
        ? HttpResponse.json({ error: "boom" }, { status: 500 })
        : HttpResponse.json([]);
    }),
  );
  return { calls, recoverVehicles: () => (vehiclesMode = "ok") };
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

async function openConversation() {
  renderConversas();
  await userEvent.click(await screen.findByText("Roberto"));
}

onAntigravity("antigravity contact rail", () => {
  beforeEach(() => {
    useSelection.setState({ selectedConversationId: null });
  });
  afterEach(() => {
    useSelection.setState({ selectedConversationId: null });
  });

  it("names the section that is still loading", async () => {
    stubRail({ scheduled: "pending" });

    await openConversation();

    expect(
      await screen.findByText("Carregando mensagens programadas"),
    ).toBeInTheDocument();
  });

  it("offers a retry on a failed section that re-issues that request", async () => {
    const { calls, recoverVehicles } = stubRail({ vehicles: "error" });

    await openConversation();

    expect(
      await screen.findByText("Não foi possível carregar os veículos"),
    ).toBeInTheDocument();
    const before = calls.vehicles;

    recoverVehicles();
    await userEvent.click(screen.getAllByRole("button", { name: "Tentar de novo" })[0]);

    await waitFor(() => expect(calls.vehicles).toBeGreaterThan(before));
    await waitFor(() =>
      expect(
        screen.queryByText("Não foi possível carregar os veículos"),
      ).not.toBeInTheDocument(),
    );
  });
});
