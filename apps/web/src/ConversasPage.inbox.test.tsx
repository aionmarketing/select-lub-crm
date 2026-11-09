/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage inside AppProviders; MSW (intercepts fetch).
 * Query retry: false.
 *
 * Spec rule (openspec/changes/conversas-inbox-completeness/specs/conversas/spec.md):
 *   Search matches phone or linked name; empty match is a Portuguese
 *   empty state. Nova conversa opens/creates when CONNECTED and does not
 *   enqueue outbox; disconnected shows contingency + Web link and does
 *   not POST. Origin badge shows UNKNOWN as desconhecida, not orgânica.
 *   Unanswered filter keeps only a pending shouldReply:true inbound.
 *   Unlabeled / false / later-outbound do not indicate. Empty unanswered
 *   filter is Portuguese copy "Nenhuma conversa não respondida".
 *   is CONNECTING/CONNECTED/DEGRADED/DISCONNECTED; composer is enabled
 *   only for CONNECTED.
 *
 * Axes
 *   A1 search query — typed text triggers a debounced GET ?q=
 *   A2 search result — one match / zero matches
 *   A3 Nova conversa channel state — CONNECTED vs DISCONNECTED
 *   A4 Nova conversa submit — POST fires vs never fires
 *   A5 origin badge sourceType — UNKNOWN / AD / ORGANIC
 *   A6 unanswered toggle — off (unfiltered) vs on (?unanswered=true)
 *   A7 channel chip state — each of the four values
 *   A8 composer gate — CONNECTED enabled vs CONNECTING disabled
 *   A9 open conversation's pipelineStage — novosContatos vs orcamentoEnviado
 *
 * Outputs: O1 GET carries ?q=; O2 Portuguese empty copy; O3 dialog POST
 *   O6 GET carries unanswered=true; O7 chip "Não respondida"; O8 empty
 *     unanswered copy; O9 chip label per channel state; O10 thread header
 *     stage label, with no control that would change it
 *
 * Sampled-cell
 *   type a phone, one match         | A1 A2 | O1 O2 | full list / no filter
 *   type text, zero matches         | A2    | O2    | list shown
 *   Nova conversa connected submit  | A3 A4 | O3    | no POST, or POST to /messages
 *   Nova conversa disconnected      | A3    | O4    | POST /conversations fires
 *   UNKNOWN badge                   | A5    | O5    | labelled orgânica
 *   AD badge                        | A5    | O5    | labelled desconhecida
 *   ORGANIC badge                   | A5    | O5    | labelled desconhecida / anúncio
 *   unanswered on                   | A6    | O6    | unfiltered request
 *   chip CONNECTING                 | A7    | O7    | wrong/missing label
 *   open thread, orcamentoEnviado   | A9    | O10   | stage absent, or editable
 *   open thread, novosContatos      | A9    | O10   | a later stage's label
 *   composer blocked while CONNECTING | A8  | O8    | Enviar enabled, POST fires
 *
 * Decision map (conversas/inbox.tsx + conversas/thread.tsx)
 *   D1 debouncedSearch truthy → q query param
 *   D2 unanswered switch → unanswered=true query param
 *   D3 NovaConversaControl: channelQuery.data?.state === "CONNECTED"
 *      T: phone form + POST; F: contingency + Web link, no POST
 *   D4 ChannelChip: query.data undefined → renders nothing; else label/color
 *      per state
 *   D4b ThreadPane header stage: THREAD_STAGE_LABELS[conversation.pipelineStage],
 *      rendered as a plain Chip — no onClick, no onDelete, no Select
 *   D5 ThreadPane canSend: channelState === "CONNECTED"
 *   D6 ConversationList origin badge: ORIGIN_LABELS[row.sourceType]
 *      UNKNOWN / AD / ORGANIC each sampled (task 3.2)
 *
 * Fails if: the thread header omits the stage, or offers any control that
 * would set it; the search GET never carries `q`; Nova conversa POSTs
 * /conversations while disconnected; a CONNECTING channel still enables
 * Enviar; UNKNOWN renders as "Orgânica".
 *
 * Out of scope: debounce timing precision (fake timers); DEGRADED trigger
 * from a real webhook payload (worker suite); WhatsApp Web fallback exact
 * copy beyond the link itself (already asserted in App.test.tsx P8).
 *
 * TagFilter apply-options loading/error (inbox.tsx returns null) — same as
 * empty (no invented chips, no error copy). Oracle: 2026-09-01 leftover
 * close-out (keep current). Empty zero-tags is already specified.
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

describe("Conversas search", () => {
  it("sends the typed text as the list query and narrows the list", async () => {
    const user = userEvent.setup();
    const queries: string[] = [];
    const maria = summary({ id: "conv-maria", phone: "11988887777", contactLabel: "Maria Silva" });
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        queries.push(q);
        return HttpResponse.json(q === "maria" ? [maria] : [maria, summary({ id: "conv-b", phone: "222" })]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("Maria Silva")).toBeInTheDocument();
    expect(screen.getByText("222")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Buscar"), "maria");

    await waitFor(() => {
      expect(queries).toContain("maria");
    });
    await waitFor(() => {
      expect(screen.queryByText("222")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Maria Silva")).toBeInTheDocument();
  });

  it("shows the Portuguese empty state when the search matches nothing", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        return HttpResponse.json(q ? [] : [summary({ id: "conv-a", phone: "111" })]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("111")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Buscar"), "nao existe");

    // align-shipped-ui-to-canvas F9: zero search matches get query-specific copy.
    expect(await screen.findByText('Nenhuma conversa para "nao existe"')).toBeInTheDocument();
  });
});

describe("Conversas unanswered filter", () => {
  it("requests unanswered=true when the switch is on", async () => {
    const user = userEvent.setup();
    const flags: (string | null)[] = [];
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        flags.push(new URL(request.url).searchParams.get("unanswered"));
        return HttpResponse.json([summary({ id: "conv-a", phone: "111" })]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    await screen.findByText("111");

    await user.click(screen.getByRole("switch", { name: "Não respondidas" }));

    await waitFor(() => {
      expect(flags).toContain("true");
    });
  });

  it("shows the unanswered chip on a pending row and not on a false row", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        const unanswered = new URL(request.url).searchParams.get("unanswered");
        if (unanswered === "true") {
          return HttpResponse.json([summary({ id: "conv-a", phone: "111", unanswered: true })]);
        }
        return HttpResponse.json([
          summary({ id: "conv-a", phone: "111", unanswered: true }),
          summary({ id: "conv-b", phone: "222", unanswered: false }),
        ]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("111")).toBeInTheDocument();
    expect(screen.getByText("Não respondida")).toBeInTheDocument();
    expect(screen.getByText("222")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Não respondidas" }));

    await waitFor(() => {
      expect(screen.queryByText("222")).not.toBeInTheDocument();
    });
    expect(screen.getByText("111")).toBeInTheDocument();
    expect(screen.getByText("Não respondida")).toBeInTheDocument();
  });

  it("shows the Portuguese empty state when the unanswered filter matches nothing", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        const unanswered = new URL(request.url).searchParams.get("unanswered");
        return HttpResponse.json(unanswered === "true" ? [] : [summary({ id: "conv-a", phone: "111" })]);
      }),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("111")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Não respondidas" }));

    expect(await screen.findByText("Nenhuma conversa não respondida")).toBeInTheDocument();
  });
});

describe("Conversas origin badge", () => {
  it("labels UNKNOWN as desconhecida, not orgânica", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "conv-a", phone: "111", sourceType: "UNKNOWN" })]),
      ),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("Desconhecida")).toBeInTheDocument();
    expect(screen.queryByText("Orgânica")).not.toBeInTheDocument();
  });

  it("labels AD as anúncio", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "conv-a", phone: "111", sourceType: "AD" })]),
      ),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("Anúncio")).toBeInTheDocument();
  });

  it("labels ORGANIC as orgânica", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "conv-a", phone: "111", sourceType: "ORGANIC" })]),
      ),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    expect(await screen.findByText("Orgânica")).toBeInTheDocument();
  });
});

describe("Conversas channel chip", () => {
  it.each([
    ["CONNECTED", "Conectado"],
    ["CONNECTING", "Conectando"],
    ["DEGRADED", "Instável"],
    ["DISCONNECTED", "Desconectado"],
  ] as const)("shows the Portuguese label for %s", async (state, label) => {
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([])),
      http.get("*/api/channel/status", () => HttpResponse.json({ state })),
    );
    renderConversas();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe("Conversas composer gated on CONNECTING", () => {
  it("blocks send while the channel is CONNECTING", async () => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([summary({ id: "conv-a", phone: "111" })]),
      ),
      http.get("*/api/conversations/:id/messages", () => HttpResponse.json([])),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTING" })),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("111"));
    // align-shipped-ui-to-canvas F8: while not CONNECTED the blocked bar
    // replaces the compose controls; CONNECTING gets no WhatsApp Web link
    // (that fallback is DISCONNECTED-only per the conversas spec).
    expect(await screen.findByText(/Envio pelo CRM indisponível/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir no WhatsApp" })).not.toBeInTheDocument();
  });
});

describe("Conversas Nova conversa", () => {
  it("opens or creates a conversation when connected and does not enqueue outbox", async () => {
    const user = userEvent.setup();
    const createPosts: string[] = [];
    const messagePosts: string[] = [];
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([])),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
      http.post("*/api/conversations", async ({ request }) => {
        const body = (await request.json()) as { phone: string };
        createPosts.push(body.phone);
        return HttpResponse.json(
          summary({ id: "conv-new", phone: "11999990000", contactLabel: "11999990000" }),
          { status: 201 },
        );
      }),
      http.post("*/api/conversations/:id/messages", async ({ request }) => {
        messagePosts.push(new URL(request.url).pathname);
        return HttpResponse.json({ error: "should-not-send" }, { status: 500 });
      }),
    );
    renderConversas();

    await user.click(await screen.findByRole("button", { name: "Nova conversa" }));
    await user.type(await screen.findByLabelText("Telefone"), "11999990000");
    await user.click(screen.getByRole("button", { name: "Iniciar" }));

    await waitFor(() => {
      expect(createPosts).toEqual(["11999990000"]);
    });
    expect(messagePosts).toEqual([]);
  });

  it("shows contingency and a Web link while disconnected, and never POSTs", async () => {
    const user = userEvent.setup();
    let createCalled = false;
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([])),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "DISCONNECTED" })),
      http.post("*/api/conversations", () => {
        createCalled = true;
        return HttpResponse.json({ code: "channel_not_connected" }, { status: 409 });
      }),
    );
    renderConversas();

    await user.click(await screen.findByRole("button", { name: "Nova conversa" }));

    expect(
      await screen.findByText(/Envio pelo CRM indisponível no momento/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Telefone")).not.toBeInTheDocument();
    const webLink = screen.getByRole("link", { name: "Abrir no WhatsApp Web" });
    expect(webLink).toHaveAttribute("href", "https://web.whatsapp.com/");
    expect(createCalled).toBe(false);
  });
});

describe("Conversas thread header pipeline stage", () => {
  /**
   * The stage is derived server-side from the same events REP-15's funnel
   * counts, so the header only ever displays it. The API half of this — that
   * neither write body accepts a `pipelineStage` — is asserted in
   * `apps/api/src/conversations.pipeline-stage.test.ts`.
   */
  it.each([
    ["orcamentoEnviado", "Orçamento enviado", "Novos Contatos"] as const,
    ["novosContatos", "Novos Contatos", "Orçamento enviado"] as const,
  ])("shows %s beside the customer name with no way to change it", async (stage, label, otherLabel) => {
    server.use(
      http.get("*/api/conversations", () =>
        HttpResponse.json([
          summary({ id: "conv-a", phone: "111", contactLabel: "Maria Silva", pipelineStage: stage }),
        ]),
      ),
      http.get("*/api/conversations/:id/messages", () => HttpResponse.json([])),
      http.get("*/api/channel/status", () => HttpResponse.json({ state: "CONNECTED" })),
    );
    renderConversas();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Maria Silva"));

    const header = await screen.findByTestId("conversas-thread-header");
    expect(within(header).getByText("Maria Silva")).toBeInTheDocument();
    const stageChip = within(header).getByText(label);
    expect(within(header).queryByText(otherLabel)).toBeNull();

    // No affordance to change it: the chip is not itself activatable, and no
    // select, editable field or delete control sits with it.
    expect(stageChip.closest("button")).toBeNull();
    expect(stageChip.closest('[role="button"]')).toBeNull();
    expect(within(header).queryByRole("combobox")).toBeNull();
    expect(within(header).queryByRole("textbox")).toBeNull();
    expect(within(header).queryByRole("button")).toBeNull();
  });
});
