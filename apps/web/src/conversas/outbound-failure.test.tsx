/**
 * Test design (testing-strategy)
 *
 * Scope: the thread's label and **Reenviar** for an outbound message that did not
 *   go out. `MessageList` is rendered directly inside `AppProviders`; MSW answers
 *   the resend POST; query and mutation retry off.
 *
 * Oracle: `hold-unknown-outcome-sends`, conversas "Thread shows outbound delivery
 *   status" and "Attendant can resend a message that did not go out":
 *   - `outcome_unknown` reads "Envio incerto — pode ter chegado. Confira antes de
 *     reenviar.", `not_sent` reads "Não enviada", in place of the raw suffix;
 *   - every other outbox status keeps its raw suffix (the owner's choice);
 *   - Reenviar on text posts once per press, never with a body, and is disabled
 *     with a Portuguese reason while the channel is not CONNECTED;
 *   - a media message shows its label and no Reenviar;
 *   - a refused resend says why, branching on the 409 body.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@select-lub/shared-types";
import { AppProviders } from "../AppProviders.js";
import { server } from "../../test/msw/server.js";
import { MessageList } from "./thread.js";

function renderList(messages: ConversationMessage[], channelConnected = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <AppProviders queryClient={queryClient}>
      <MessageList conversationId="con_1" messages={messages} channelConnected={channelConnected} />
    </AppProviders>,
  );
}

function outbound(id: string, extra: Partial<ConversationMessage>): ConversationMessage {
  return {
    id,
    direction: "outbound",
    messageType: "text",
    textBody: `texto ${id}`,
    providerTimestamp: "2026-09-25T12:00:00.000Z",
    ...extra,
  };
}

/** Records every resend request; answers 201 with a queued copy. */
function recordResends(answer?: () => Response) {
  const calls: { messageId: string; body: string }[] = [];
  server.use(
    http.post("*/api/conversations/:id/messages/:messageId/resend", async ({ params, request }) => {
      calls.push({ messageId: String(params.messageId), body: await request.text() });
      return (
        answer?.() ??
        HttpResponse.json(outbound("copy", { outboxStatus: "queued" }), { status: 201 })
      );
    }),
  );
  return calls;
}

describe("an outbound message that did not go out", () => {
  it("labels each kind in Portuguese in place of the raw suffix, and leaves other statuses raw", () => {
    renderList([
      outbound("u", { outboxStatus: "failed", outboxFailure: "outcome_unknown" }),
      outbound("n", { outboxStatus: "blocked", outboxFailure: "not_sent" }),
      outbound("b", { outboxStatus: "blocked" }),
      outbound("c", { outboxStatus: "cancelled" }),
    ]);

    expect(screen.getByText("Envio incerto — pode ter chegado. Confira antes de reenviar.")).toBeInTheDocument();
    expect(screen.getByText("Não enviada")).toBeInTheDocument();
    expect(screen.queryByText(/· failed/)).not.toBeInTheDocument();
    // A reminder copy's blocked row, and a cancelled one, keep the raw suffix.
    expect(screen.getAllByText(/· blocked/)).toHaveLength(1);
    expect(screen.getByText(/· cancelled/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reenviar" })).toHaveLength(2);
  });

  it("resends once per press, with no body", async () => {
    const calls = recordResends();
    renderList([outbound("u", { outboxStatus: "failed", outboxFailure: "outcome_unknown" })]);

    const button = screen.getByRole("button", { name: "Reenviar" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ messageId: "u", body: "" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled());
    expect(calls).toHaveLength(1);
  });

  it("disables Reenviar with the reason while the channel is down", () => {
    const calls = recordResends();
    renderList([outbound("n", { outboxStatus: "failed", outboxFailure: "not_sent" })], false);

    const button = screen.getByRole("button", { name: "Reenviar" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Canal desconectado — reenvio indisponível.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(calls).toHaveLength(0);
  });

  it("offers no Reenviar on media", () => {
    renderList([
      outbound("img", { messageType: "image", textBody: null, outboxStatus: "failed", outboxFailure: "not_sent" }),
    ]);

    expect(screen.getByText("Não enviada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reenviar" })).not.toBeInTheDocument();
    expect(screen.getByText("Anexe o arquivo de novo para reenviar.")).toBeInTheDocument();
  });

  it.each([
    [{ error: "resend_not_allowed" }, "Esta mensagem não pode mais ser reenviada."],
    [{ state: "DISCONNECTED" }, "Canal desconectado — não foi possível reenviar."],
  ])("says why a resend was refused (%j)", async (body, copy) => {
    recordResends(() => HttpResponse.json(body, { status: 409 }));
    const { container } = renderList([outbound("u", { outboxStatus: "failed", outboxFailure: "outcome_unknown" })]);

    fireEvent.click(screen.getByRole("button", { name: "Reenviar" }));

    expect(await within(container).findByRole("alert")).toHaveTextContent(copy);
  });

  // hold-unknown-followups.
  it("shows Reenviada instead of Reenviar once the message was resent", () => {
    renderList([
      outbound("r", { outboxStatus: "failed", outboxFailure: "outcome_unknown", outboxResent: true }),
      outbound("n", { outboxStatus: "failed", outboxFailure: "not_sent" }),
    ]);

    expect(screen.getByText("Reenviada")).toBeInTheDocument();
    // Only the one not yet resent still offers the button.
    expect(screen.getAllByRole("button", { name: "Reenviar" })).toHaveLength(1);
  });

  it("shows Reenviada on a blocked send the resend cancelled, and leaves a plain cancel raw", () => {
    renderList([
      outbound("x", { outboxStatus: "cancelled", outboxResent: true }),
      outbound("y", { outboxStatus: "cancelled" }),
    ]);

    expect(screen.getByText("Reenviada")).toBeInTheDocument();
    // Only the one cancelled without a resend keeps its raw status.
    expect(screen.getAllByText(/· cancelled/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Reenviar" })).not.toBeInTheDocument();
  });

  it("names each Reenviar by its own message", () => {
    renderList([
      outbound("a", { outboxStatus: "failed", outboxFailure: "not_sent" }),
      outbound("b", { outboxStatus: "failed", outboxFailure: "not_sent" }),
    ]);

    expect(screen.getByRole("button", { name: "Reenviar", description: /texto a/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar", description: /texto b/ })).toBeInTheDocument();
  });
});
