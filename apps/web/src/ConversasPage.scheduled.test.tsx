/**
 * Test design (testing-strategy)
 *
 * Setup: ConversasPage in AppProviders; MSW. Query retry: false.
 *
 * Oracle: scheduled-messages-ui conversas delta — Programar mensagem on a
 * service row is the only schedule entry; AC-CONV-05 2026-01-15 → 2026-07-15
 * shown before confirm; confirm POSTs scheduled-messages and does not send
 * WhatsApp; confirm/cancel disabled with Portuguese reason when the channel
 * is not CONNECTED; cancel removes an active SCHEDULED row.
 *
 * The dialog holds ONLY the form (design D5): the conversation's scheduled
 * messages are read on the rail's Mensagens programadas section and cancelled
 * from that section's drill-in, so the cancel cases live there rather than
 * behind a "Ver programadas" switch inside the dialog.
 *
 * Axes
 *   A1 channel — CONNECTED vs DISCONNECTED
 *   A2 action — confirm vs cancel
 *   A3 entry — service Programar mensagem vs generic Programar / Templates
 *   A4 rail programadas state — loading / error / no customer / empty / populated
 *   A5 programadas view — preview (created desc) vs Ver tudo (send order)
 *   A6 detail status — SCHEDULED vs FAILED
 *   A7 GET /scheduled-messages/:id — ok / 500
 *
 * Outputs
 *   O1 form prefills service + 15/07/2026
 *   O2 POST /scheduled-messages once; no POST /messages
 *   O3 Confirmar disabled + reason; no create POST
 *   O4 cancel POST; row leaves SCHEDULED
 *   O5 Cancelar disabled; row stays SCHEDULED
 *   O6 no generic Programar / Templates heading
 *   O7 dialog carries the form alone: editable body, Data + Hora, the zone
 *      named, and no embedded list or Ver programadas switch
 *   O8 preview lists the two newest-created, Ver tudo present past two
 *   O9 Ver tudo list ordered soonest-pending-first, then resolved by recency
 *   O10 drill-in region (never a dialog) naming instant + zone, template,
 *       origin service, creator; Voltar restores the stack
 *   O11 cancel from the drill-in POSTs; disconnected disables it with a reason
 *   O12 FAILED names its recorded reason and offers no cancel
 *   O13 a refused cancel (apply-owner-rulings-2026-09-25): 409 CONNECTED says the
 *       message is already on its way and re-reads the row; 409 DISCONNECTED
 *       states the channel reason; any other failure a Portuguese retry line
 *   O13 Portuguese loading / error / no-customer / empty cuts of the section
 *
 * Sampled-cell
 *   shortcut date           | A3 service        | O1 | generic Programar
 *   confirm connected       | A1 CONNECTED A2 confirm | O2 | POST /messages
 *   confirm disconnected    | A1 DISCONNECTED A2 confirm | O3 | POST create
 *   form-only dialog        | A3 service        | O7 | list inside the dialog
 *   no generic entry        | A3 generic        | O6 | Templates heading
 *   existing schedule blocks| A3 occupied       | O7 confirm disabled + reason | 201 second row
 *   preview newest first    | A5 preview        | O8 two newest, third hidden | created order ignored
 *   Ver tudo send order     | A5 full           | O9 pending soonest first | preview order reused
 *   drill-in + Voltar       | A4 populated      | O10 rail region, no dialog | dialog opened
 *   cancel connected        | A1 CONNECTED A6 SCHEDULED | O11 cancel POST | silent no-op
 *   cancel disconnected     | A1 DISCONNECTED   | O11 disabled + reason | cancel POST
 *   failed message          | A6 FAILED         | O12 reason, no cancel | cancel offered
 *   cancel already sending  | 409 CONNECTED     | O13 info + refetch    | silent, or shown Cancelada
 *   cancel, api says down   | 409 DISCONNECTED  | O13 channel reason    | the "already sending" text
 *   cancel fails otherwise  | 500               | O13 retry line        | silent no-op
 *   detail 500 + retry      | A7 500            | O10 error copy then detail | silent fail
 *   list loading then 500   | A4 loading/error  | O13 both copies + retry | empty copy first
 *   linked, zero messages   | A4 empty          | O13 empty copy, no Ver tudo | no-customer copy
 *   no linked customer      | A4 no customer    | O13 no-customer copy | empty copy
 *
 * Decision map (conversas/schedule.tsx, conversas/contact-rail.tsx, conversas/drill-ins.tsx)
 *   D1 channel === CONNECTED  T: confirm/cancel its; F: disconnected its
 *   D2 confirmBlocked on empty date/time — covered by the form-only case,
 *     which reads Hora as the suggestion's 00:00 rather than an empty control
 *   D3 service already scheduled T: blocked it; F: Programar enabled its
 *   D4 railView programadasFull T: Ver tudo list; F: preview
 *   D5 railView programadaDetail T: drill-in; F: the lists
 *   D6 schedules.length > 2   T: Ver tudo shown; F: hidden on the empty cut
 *   D7 customer == null       T: no-customer copy; F: empty / populated
 *   D8 schedules.length === 0 T: empty copy; F: rows
 *   D9 list isLoading/isError T: loading + error copies; F: rows
 *   D10 detail status SCHEDULED T: cancel offered; F: FAILED has none
 *   D11 detail lastError non-null T: reason shown; F: no failure alert
 *   D12 templateName / originatingService / createdByName null
 *                             T: the three Portuguese fallbacks; F: resolved labels
 *   D13 detail GET error      T: error+retry; F: rendered detail
 *   activeTemplates.length > 0 T — infeasible on Conversas (remove-rail-templates;
 *     GET /templates does not run; template Select is not mounted)
 *   template !nextId / preview catch — same (control not mounted)
 *
 * Out of scope: worker dispatch; 409 HTTP (already in scheduled-messages);
 * Playwright.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  customerFixture,
  type ChannelStatus,
  type ConversationSummary,
  type ScheduledMessage,
  type ScheduledMessageDetail,
  type Service,
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
    // Inbound-only default; `partial` still overrides it for a case that wants
    // a further stage.
    pipelineStage: "novosContatos",
    ...partial,
  };
}

function serviceRow(partial: Partial<Service> & Pick<Service, "id">): Service {
  return {
    customerId: "cus-svc",
    vehicleId: null,
    omieId: null,
    unitId: "unit-1",
    performedAt: null,
    description: null,
    kind: null,
    status: null,
    amount: null,
    odometerKm: null,
    origin: "crm",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

const janOil = serviceRow({
  id: "svc-jan",
  performedAt: "2026-01-15T00:00:00.000Z",
  description: "Troca de óleo",
});

function scheduledRow(partial: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: "sch-1",
    customerId: "cus-svc",
    conversationId: "conv-1",
    serviceId: "svc-jan",
    returnReminderMessageId: null,
    templateId: null,
    text: "Retorno da troca de óleo",
    scheduledAt: "2099-01-15T13:00:00.000Z",
    timeZone: "America/Sao_Paulo",
    status: "SCHEDULED",
    idempotencyKey: "idem-1",
    suggestedAt: "2026-07-15T03:00:00.000Z",
    suggestionSource: "six_months",
    createdByUserId: "user-1",
    createdAt: "2026-08-31T12:00:00.000Z",
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

function stubScheduleApis(options: {
  channel?: ChannelStatus["state"];
  scheduled?: ScheduledMessage[];
  created?: ScheduledMessage;
  /** Linked customer for the conversation; null is the unlinked cut. */
  customerId?: string | null;
}) {
  const channel = options.channel ?? "CONNECTED";
  const customerId = options.customerId === undefined ? "cus-svc" : options.customerId;
  let scheduled = [...(options.scheduled ?? [])];
  const creates: unknown[] = [];
  const cancels: string[] = [];
  const messages: unknown[] = [];
  server.use(
    http.get("*/api/channel/status", () => HttpResponse.json({ state: channel })),
    http.get("*/api/conversations/:id/services", () =>
      HttpResponse.json({ customerId, services: customerId === null ? [] : [janOil] }),
    ),
    http.get("*/api/services/:id/suggest-schedule-date", () =>
      HttpResponse.json({
        suggestedAt: "2026-07-15T03:00:00.000Z",
        suggestionSource: "six_months",
      }),
    ),
    http.get("*/api/conversations/:id/scheduled-messages", () => HttpResponse.json(scheduled)),
    http.post("*/api/conversations/:id/scheduled-messages/:scheduleId/cancel", ({ params }) => {
      cancels.push(String(params.scheduleId));
      scheduled = scheduled.map((row) =>
        row.id === params.scheduleId ? { ...row, status: "CANCELLED" as const } : row,
      );
      const row = scheduled.find((item) => item.id === params.scheduleId);
      return HttpResponse.json(row ?? scheduledRow({ id: String(params.scheduleId), status: "CANCELLED" }));
    }),
    http.post("*/api/conversations/:id/scheduled-messages", async ({ request }) => {
      const body = await request.json();
      creates.push(body);
      const created = options.created ?? scheduledRow({ text: (body as { text: string }).text });
      scheduled = [...scheduled, created];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post("*/api/conversations/:id/messages", async ({ request }) => {
      messages.push(await request.json());
      return HttpResponse.json({ error: "unexpected send" }, { status: 500 });
    }),
  );
  return { creates, cancels, messages };
}

async function openInbox(conv: ConversationSummary) {
  server.use(http.get("*/api/conversations", () => HttpResponse.json([conv])));
  renderConversas();
  await userEvent.setup().click(await screen.findByText(conv.contactLabel));
}

/**
 * Links a customer so the rail's Mensagens programadas section reaches its
 * populated states — with no customer the section is the "Nenhum cliente
 * vinculado" cut, which is itself one of the cases below.
 */
function stubLinkedCustomer() {
  server.use(
    http.get("*/api/conversations/:id/customer", () =>
      HttpResponse.json({
        customer: { ...customerFixture, name: "Roberto Aparecido" },
        pendings: [],
      }),
    ),
  );
}

function detailRow(partial: Partial<ScheduledMessageDetail> = {}): ScheduledMessageDetail {
  return {
    ...scheduledRow(),
    lastError: null,
    templateName: "Lembrete de retorno",
    createdByName: "Roberta Nunes",
    originatingService: {
      id: "svc-jan",
      omieId: null,
      description: "Troca de óleo",
      performedAt: "2026-01-15T00:00:00.000Z",
    },
    ...partial,
  };
}

function stubScheduleDetail(detail: ScheduledMessageDetail) {
  server.use(http.get("*/api/scheduled-messages/:id", () => HttpResponse.json(detail)));
}

async function openProgramadasSection(conv: ConversationSummary) {
  stubLinkedCustomer();
  await openInbox(conv);
  return screen.findByRole("region", { name: "Mensagens programadas" });
}

async function openScheduleForm(conv: ConversationSummary) {
  await openInbox(conv);
  const rail = await screen.findByRole("region", { name: "Serviços" });
  await userEvent.setup().click(within(rail).getByRole("button", { name: "Programar mensagem" }));
  return screen.findByRole("dialog");
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("Conversas scheduled messages", () => {
  it("prefills the January oil service and shows 15/07/2026 before confirm", async () => {
    const conv = summary({
      id: "conv-1",
      phone: "11988887777",
      contactLabel: "Roberto Aparecido",
    });
    stubScheduleApis({});
    const dialog = await openScheduleForm(conv);

    expect(await within(dialog).findByText(/15\/01\/2026 · Troca de óleo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Cliente: Roberto Aparecido/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/Data sugerida: 15\/07\/2026/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
  });

  it("confirms a future schedule without posting to WhatsApp send", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    const { creates, messages } = stubScheduleApis({});
    stubLinkedCustomer();
    const dialog = await openScheduleForm(conv);
    await within(dialog).findByText(/Data sugerida: 15\/07\/2026/);
    const user = userEvent.setup();

    await user.type(within(dialog).getByLabelText("Mensagem"), "Retorno da troca de óleo");
    const date = within(dialog).getByLabelText("Data");
    await user.clear(date);
    await user.type(date, "2099-01-15");
    const time = within(dialog).getByLabelText("Hora");
    await user.clear(time);
    await user.type(time, "10:00");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar" }));

    await waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    expect(creates[0]).toEqual(
      expect.objectContaining({
        text: "Retorno da troca de óleo",
        // 10:00 in America/Sao_Paulo (UTC−3, no DST) is 13:00 UTC — the form
        // states the zone rather than reading the runner's clock.
        scheduledAt: "2099-01-15T13:00:00.000Z",
        serviceId: "svc-jan",
      }),
    );
    expect(messages).toHaveLength(0);
    // The confirmed message is read on the rail, so the dialog closes rather
    // than turning into a list.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const section = await screen.findByRole("region", { name: "Mensagens programadas" });
    expect(await within(section).findByText("Retorno da troca de óleo")).toBeInTheDocument();
  });

  it("holds only the form: no embedded list, no Ver programadas, and the zone is stated", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    const dialog = await openScheduleForm(conv);

    expect(within(dialog).queryByRole("button", { name: "Ver programadas" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Retorno da troca de óleo")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Programada")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Mensagem")).toBeEnabled();
    expect(within(dialog).getByLabelText("Hora")).toHaveValue("00:00");
    expect(within(dialog).getByText("Fuso America/Sao_Paulo")).toBeInTheDocument();
  });

  it("disables confirm while disconnected and does not create a schedule", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    const { creates } = stubScheduleApis({ channel: "DISCONNECTED" });
    const dialog = await openScheduleForm(conv);
    await within(dialog).findByText(/Data sugerida: 15\/07\/2026/);
    const user = userEvent.setup();

    await user.type(within(dialog).getByLabelText("Mensagem"), "Retorno da troca de óleo");

    expect(within(dialog).getByText("Envio pelo CRM indisponível.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(creates).toHaveLength(0);
  });

  it("has no generic Programar entry or Templates heading", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({});
    await openInbox(conv);

    const rail = await screen.findByRole("region", { name: "Serviços" });
    expect(await within(rail).findByRole("button", { name: "Programar mensagem" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Programar$/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("Templates de mensagem")).not.toBeInTheDocument();
  });

  it("previews the two most recently created messages beside Serviços, newest first", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({
      scheduled: [
        scheduledRow({ id: "sch-old", text: "Boas-vindas", createdAt: "2026-08-01T12:00:00.000Z" }),
        scheduledRow({ id: "sch-new", text: "Lembrete de retorno", createdAt: "2026-08-31T12:00:00.000Z" }),
        scheduledRow({ id: "sch-mid", text: "Lembrete de revisão", createdAt: "2026-08-15T12:00:00.000Z" }),
      ],
    });
    const section = await openProgramadasSection(conv);

    const rows = await within(section).findAllByTestId("conversas-programada-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Lembrete de retorno ›",
      "Lembrete de revisão ›",
    ]);
    expect(within(section).queryByText("Boas-vindas")).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Ver tudo" })).toBeInTheDocument();
  });

  it("orders the Ver tudo list by soonest pending send, then resolved by recency", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({
      scheduled: [
        scheduledRow({ id: "sch-sent", text: "Enviada antiga", status: "SENT", scheduledAt: "2026-08-20T13:00:00.000Z" }),
        scheduledRow({ id: "sch-late", text: "Programada tarde", scheduledAt: "2099-03-01T13:00:00.000Z" }),
        scheduledRow({ id: "sch-soon", text: "Programada logo", scheduledAt: "2099-01-15T13:00:00.000Z" }),
      ],
    });
    const section = await openProgramadasSection(conv);
    await userEvent.setup().click(within(section).getByRole("button", { name: "Ver tudo" }));

    const full = await screen.findByRole("region", { name: "Mensagens programadas" });
    const rows = await within(full).findAllByTestId("conversas-programada-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Programada logo ›",
      "Programada tarde ›",
      "Enviada antiga ›",
    ]);
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
  });

  it("opens the scheduled-message drill-in as a rail view, not a dialog, and Voltar restores the stack", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    stubScheduleDetail(detailRow());
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    expect(within(detail).getByText("15/01/2099 10:00 · America/Sao_Paulo")).toBeInTheDocument();
    expect(within(detail).getByText("Programada")).toBeInTheDocument();
    expect(within(detail).getByText("Lembrete de retorno")).toBeInTheDocument();
    expect(within(detail).getByText("15/01/2026 · Troca de óleo")).toBeInTheDocument();
    expect(within(detail).getByText("Roberta Nunes")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.setup().click(within(detail).getByRole("button", { name: /Voltar/ }));

    expect(await screen.findByText("Tags")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mensagem programada" })).not.toBeInTheDocument();
  });

  it("cancels the send from the drill-in while connected", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    const { cancels } = stubScheduleApis({ scheduled: [scheduledRow()] });
    stubScheduleDetail(detailRow());
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    await userEvent.setup().click(await within(detail).findByRole("button", { name: "Cancelar envio" }));

    await waitFor(() => {
      expect(cancels).toEqual(["sch-1"]);
    });
  });

  it("blocks cancel in the drill-in while disconnected and states the reason", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    const { cancels } = stubScheduleApis({ channel: "DISCONNECTED", scheduled: [scheduledRow()] });
    stubScheduleDetail(detailRow());
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    expect(await within(detail).findByRole("button", { name: "Cancelar envio" })).toBeDisabled();
    expect(within(detail).getByText("Envio pelo CRM indisponível.")).toBeInTheDocument();
    expect(cancels).toHaveLength(0);
  });

  it("says a message already on its way cannot be cancelled, and re-reads it", async () => {
    // The worker picked it up between the rail's read and the click: the api
    // answers 409 CONNECTED and changes nothing (owner rulings, 2026-09-25).
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    let detailReads = 0;
    let picked = false;
    server.use(
      http.get("*/api/scheduled-messages/:id", () => {
        detailReads += 1;
        return HttpResponse.json(detailRow(picked ? { status: "PROCESSING" } : {}));
      }),
      http.post("*/api/conversations/:id/scheduled-messages/:scheduleId/cancel", () => {
        picked = true;
        return HttpResponse.json({ state: "CONNECTED" }, { status: 409 });
      }),
    );
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));
    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    await userEvent.setup().click(await within(detail).findByRole("button", { name: "Cancelar envio" }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent(
      "Esta mensagem já está sendo enviada ou já foi enviada, e não pode mais ser cancelada.",
    );
    // Re-read: the row now shows its own status, and it is not shown cancelled.
    expect(await within(detail).findByText("Processando")).toBeInTheDocument();
    expect(detailReads).toBeGreaterThanOrEqual(2);
    expect(within(detail).queryByText("Cancelada")).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Cancelar envio" })).not.toBeInTheDocument();
  });

  it("states the channel reason when the api refuses the cancel as disconnected", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    stubScheduleDetail(detailRow());
    server.use(
      http.post("*/api/conversations/:id/scheduled-messages/:scheduleId/cancel", () =>
        HttpResponse.json({ state: "DISCONNECTED" }, { status: 409 }),
      ),
    );
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));
    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    await userEvent.setup().click(await within(detail).findByRole("button", { name: "Cancelar envio" }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent("Envio pelo CRM indisponível.");
    expect(within(detail).queryByText(/já está sendo enviada/)).not.toBeInTheDocument();
  });

  it("offers a Portuguese retry line when the cancel fails for another reason", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    stubScheduleDetail(detailRow());
    server.use(
      http.post("*/api/conversations/:id/scheduled-messages/:scheduleId/cancel", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));
    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    await userEvent.setup().click(await within(detail).findByRole("button", { name: "Cancelar envio" }));

    expect(await within(detail).findByRole("alert")).toHaveTextContent(
      "Não foi possível cancelar o envio. Tente de novo.",
    );
    // Still cancellable: the row was not changed, so the control stays.
    expect(within(detail).getByRole("button", { name: "Cancelar envio" })).toBeEnabled();
  });

  it("names the failure reason and offers no cancel on a FAILED message", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow({ status: "FAILED" })] });
    stubScheduleDetail(
      detailRow({
        status: "FAILED",
        lastError: "conexão indisponível",
        templateName: null,
        createdByName: null,
        originatingService: null,
      }),
    );
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    expect(await within(detail).findByText("Falhou · conexão indisponível")).toBeInTheDocument();
    expect(within(detail).getByText("Sem template")).toBeInTheDocument();
    expect(within(detail).getByText("Sem serviço de origem")).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Cancelar envio" })).not.toBeInTheDocument();
  });

  it("shows Portuguese error and retry when the scheduled-message detail read fails", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({ scheduled: [scheduledRow()] });
    let gets = 0;
    server.use(
      http.get("*/api/scheduled-messages/:id", () => {
        gets += 1;
        return gets === 1
          ? HttpResponse.json({ error: "fail" }, { status: 500 })
          : HttpResponse.json(detailRow());
      }),
    );
    const section = await openProgramadasSection(conv);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Ver mensagem programada Retorno da troca de óleo" }));

    const detail = await screen.findByRole("region", { name: "Mensagem programada" });
    expect(
      await within(detail).findByText("Não foi possível carregar a mensagem programada"),
    ).toBeInTheDocument();
    await userEvent.setup().click(within(detail).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(detail).findByText("Roberta Nunes")).toBeInTheDocument();
  });

  it("shows Portuguese empty copy for a linked customer with no scheduled messages", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({});
    const section = await openProgramadasSection(conv);

    expect(await within(section).findByText("Nenhuma mensagem programada")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("shows Portuguese loading then error and retry for the scheduled-message list", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    stubScheduleApis({});
    stubLinkedCustomer();
    let gets = 0;
    // The first read is held open until the loading cut has been observed, so
    // the assertion does not race a fixed delay.
    let releaseFirstRead = () => {};
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conv])),
      http.get("*/api/conversations/:id/scheduled-messages", async () => {
        gets += 1;
        if (gets === 1) {
          await firstRead;
          return HttpResponse.json({ error: "fail" }, { status: 500 });
        }
        return HttpResponse.json([scheduledRow()]);
      }),
    );
    renderConversas();
    await userEvent.setup().click(await screen.findByText(conv.contactLabel));

    expect(await screen.findByText("Carregando mensagens programadas")).toBeInTheDocument();
    releaseFirstRead();
    const section = await screen.findByRole("region", { name: "Mensagens programadas" });
    expect(
      await within(section).findByText("Não foi possível carregar as mensagens programadas"),
    ).toBeInTheDocument();
    await userEvent.setup().click(within(section).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(section).findByText("Retorno da troca de óleo")).toBeInTheDocument();
  });

  it("says no customer is linked rather than empty when the conversation has none", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    // The section reads the same linked-customer signal the Serviços section
    // does, so the unlinked cut is expressed by the services read, not by
    // withholding the customer stub.
    stubScheduleApis({ scheduled: [scheduledRow()], customerId: null });
    await openInbox(conv);

    const section = await screen.findByRole("region", { name: "Mensagens programadas" });
    expect(await within(section).findByText("Nenhum cliente vinculado")).toBeInTheDocument();
    expect(within(section).queryByTestId("conversas-programada-row")).not.toBeInTheDocument();
  });

  it("blocks confirm when that service already has a non-cancelled schedule", async () => {
    const conv = summary({ id: "conv-1", phone: "11988887777", contactLabel: "Roberto Aparecido" });
    const { creates } = stubScheduleApis({ scheduled: [scheduledRow()] });
    const dialog = await openScheduleForm(conv);

    expect(await within(dialog).findByText("Este serviço já tem uma mensagem programada.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(creates).toHaveLength(0);
  });
});
