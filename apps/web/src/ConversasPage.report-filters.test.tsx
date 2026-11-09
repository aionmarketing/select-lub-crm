/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage inside AppProviders, MemoryRouter carrying the initial
 * URL a Relatórios drill-through would produce; MSW intercepts fetch; query
 * retry false.
 *
 * Oracle: align-shipped-ui-to-revised-canvas task 13.7 and
 * conversas/spec.md's "Conversas inbox composes origin, pipeline stage and
 * period" and "A conversation can be opened at a specified message". Task
 * 11.8's contract note is the other half: `GET /conversations` answers an
 * unknown origin or stage with an EMPTY array, not a 400 and not the
 * unfiltered list — so whether a filter was SENT, as opposed to what it
 * matched, is this screen's to track, and that is what the empty-cut copy
 * and the composition tests below are actually checking.
 *
 * Axes
 *   A1 URL filters: stage only / origin only / stage+origin+period / none
 *   A2 request built: origin/stage/from/to reach the GET as sent
 *   A3 chips: rendered for each active filter, with the right label
 *   A4 chip removal: removing one clears it from state and from the next GET
 *   A5 empty cut: report filter active and zero rows → distinct Portuguese
 *      copy, not the plain "Nenhuma conversa"
 *   A6 target message: present and matching / absent / naming another
 *      conversation's message
 *
 * Outputs: O1 the query string sent; O2 rendered chip text; O3 Portuguese
 *   empty copy; O4 the marked message element; O5 absence of a mark
 *
 * Sampled-cell
 *   it                                          | axes   | expect | fails if
 *   opens with stage+origin+period as chips      | A1,A3  | O2  | chip missing or mislabelled
 *   sends stage/origin/from/to on the request     | A2     | O1  | a filter silently dropped
 *   removing the stage chip drops it from the GET | A4     | O1  | filter still sent after removal
 *   empty cut under a report filter has its own copy | A5 | O3  | generic "Nenhuma conversa" shown
 *   opens positioned on the named message          | A6    | O4  | not marked / not scrolled to
 *   an unknown target degrades to normal position   | A6   | O5  | throws or marks the wrong row
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ConversasPage } from "./ConversasPage.js";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";

function summary(partial: Partial<ConversationSummary> & Pick<ConversationSummary, "id" | "phone">): ConversationSummary {
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

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
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

describe("the inbox filters from a Relatórios drill-through", () => {
  it("opens with stage, origin and period all shown as chips", async () => {
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([summary({ id: "c1", phone: "+551199" })])),
    );
    renderAt("/?stage=orcamentoEnviado&origin=AD&from=2026-08-01&to=2026-08-28");

    expect(await screen.findByText("Etapa: Orçamento enviado")).toBeInTheDocument();
    expect(screen.getByText("Origem: Anúncio")).toBeInTheDocument();
    expect(screen.getByText("01/08 – 28/08/2026")).toBeInTheDocument();
  });

  it("sends origin, stage, from and to on the request", async () => {
    let sentQuery = "";
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        sentQuery = new URL(request.url).search;
        return HttpResponse.json([]);
      }),
    );
    renderAt("/?stage=orcamentoEnviado&origin=AD&from=2026-08-01&to=2026-08-28");

    await waitFor(() => expect(sentQuery).toContain("stage=orcamentoEnviado"));
    expect(sentQuery).toContain("origin=AD");
    expect(sentQuery).toContain("from=2026-08-01");
    expect(sentQuery).toContain("to=2026-08-28");
  });

  it("dropping the stage chip removes it from the next request", async () => {
    let lastQuery = "";
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        lastQuery = new URL(request.url).search;
        return HttpResponse.json([]);
      }),
    );
    const user = userEvent.setup();
    renderAt("/?stage=orcamentoEnviado&origin=AD&from=2026-08-01&to=2026-08-28");

    await screen.findByText("Etapa: Orçamento enviado");
    await waitFor(() => expect(lastQuery).toContain("stage="));
    await user.click(screen.getByRole("button", { name: "Remover filtro de etapa" }));

    await waitFor(() => expect(lastQuery).not.toContain("stage="));
    // The other two filters were not touched by removing the first.
    expect(lastQuery).toContain("origin=AD");
    expect(screen.queryByText("Etapa: Orçamento enviado")).toBeNull();
  });

  it("names the report cut as empty rather than the generic empty copy", async () => {
    server.use(http.get("*/api/conversations", () => HttpResponse.json([])));
    renderAt("/?stage=servicosFeitos&from=2026-08-01&to=2026-08-28");

    expect(await screen.findByText("Nenhuma conversa neste recorte do relatório")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma conversa")).toBeNull();
  });

  it("still lists conversations normally with no report filter in the URL", async () => {
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([summary({ id: "c1", phone: "+551199" })])),
    );
    renderAt("/");

    expect(await screen.findByText("+551199")).toBeInTheDocument();
    expect(screen.queryByLabelText("Filtros do relatório")).toBeNull();
  });
});

describe("opening a conversation at a target message", () => {
  it("opens positioned on the named message, visibly marked", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "c1", phone: "+551199" })]),
      ),
      http.get("*/api/conversations/:id/messages", () =>
        HttpResponse.json([
          {
            id: "m1",
            direction: "inbound",
            messageType: "text",
            textBody: "oi",
            providerTimestamp: "2026-08-20T12:00:00.000Z",
          },
          {
            id: "m2",
            direction: "outbound",
            messageType: "text",
            textBody: "orçamento enviado",
            providerTimestamp: "2026-08-20T12:05:00.000Z",
            providerStatus: "delivered",
          },
        ]),
      ),
    );
    renderAt("/?conversation=c1&message=m2");
    const target = await screen.findByTestId("message-target");
    expect(within(target).getByText("orçamento enviado")).toBeInTheDocument();
  });

  it("degrades to the normal position when the target message does not exist", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "c1", phone: "+551199" })]),
      ),
      http.get("*/api/conversations/:id/messages", () =>
        HttpResponse.json([
          {
            id: "m1",
            direction: "inbound",
            messageType: "text",
            textBody: "oi",
            providerTimestamp: "2026-08-20T12:00:00.000Z",
          },
        ]),
      ),
    );
    renderAt("/?conversation=c1&message=deleted-message");

    await screen.findByText("oi");
    expect(screen.queryByTestId("message-target")).toBeNull();
  });

  it("opens at the normal position when no target is given", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "c1", phone: "+551199" })]),
      ),
      http.get("*/api/conversations/:id/messages", () =>
        HttpResponse.json([
          {
            id: "m1",
            direction: "inbound",
            messageType: "text",
            textBody: "oi",
            providerTimestamp: "2026-08-20T12:00:00.000Z",
          },
        ]),
      ),
    );
    renderAt("/?conversation=c1");

    await screen.findByText("oi");
    expect(screen.queryByTestId("message-target")).toBeNull();
  });
});
