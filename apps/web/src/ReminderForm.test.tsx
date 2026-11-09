/**
 * Test design (testing-strategy)
 *
 * SUT: ReminderForm rendered under AppProviders with MSW serving
 * `POST /api/vehicle-returns/:id/reminders`; query retry false, `now` injected.
 *
 * Oracle: align-shipped-ui-to-revised-canvas task 12.4 — "the vehicle's return
 * as prefill source, the composed default text, and a list of send moments
 * defaulting to one on the return date, with add and remove", plus the
 * approved artboard's rule that a moment's hour is shown, never applied behind
 * the operator.
 *
 * The defaulting rule is the case worth the most here. A moment on the return
 * date is the plain reading of "remind me when it is due", and it is exactly
 * wrong on an OVERDUE return: that date is past, the server refuses it with
 * trigger_in_past, and Retorno vencido is the FIRST and busiest section of the
 * screen. A suite that only ever creates reminders on future-dated returns
 * passes while the main path 409s, so both sides are pinned below.
 *
 * Axes
 *   A1 return date: ahead of now / today / already past
 *   A2 moment count: the default one / several / removing back to one
 *   A3 body: left blank (composed default) / typed over
 *   A4 send target: a conversation / none
 *   A5 outcome: created / refused, per refusal code / channel disconnected
 *   A6 channel: connected / not connected (component prop, not a refusal)
 *   A7 editing a moment: day changed / hour changed
 *
 * Outputs: O1 the request body the client sent; O2 rendered Portuguese;
 * O3 disabled state; O4 the follow-up read being invalidated; O5 the
 * disconnected banner; O6 an edited moment's new day/time in the posted
 * trigger
 *
 * Sampled-cell
 *   it                                            | axes    | expect | fails if
 *   one moment on the return date when it is ahead | A1,A2  | O1  | offset or past
 *   an overdue return defaults to a date ahead     | A1     | O1  | 409 on the main path
 *   three moments post three triggers              | A2     | O1  | only one sent
 *   removing is blocked at the last moment         | A2     | O3  | empty list postable
 *   blank body omits bodyTemplate                  | A3     | O1  | empty string sent
 *   no conversation blocks confirm                 | A4     | O3  | posts nowhere
 *   a past moment is refused in Portuguese         | A5     | O2  | raw code shown
 *   creating refreshes the queue                   | A5     | O4  | stale summary
 *   not connected disables confirm and warns       | A6     | O3,O5 | submit allowed silently
 *   channel drops mid-submit (DISCONNECTED refusal) | A5    | O2  | raw state shown
 *   editing a moment's day and hour                | A7    | O6  | edit not reflected in the post
 *
 * Oracle for the three new axes: ReminderForm.tsx's own JSDoc on `connected`
 * (line ~107: "False disables confirm rather than letting the operator
 * submit into a refusal") governs both A6 (the render-time disabled+banner
 * case) and the DISCONNECTED half of A5 — the doc's own word "refusal"
 * is exactly what `refusalCopy`'s `body?.state === "DISCONNECTED"` branch
 * produces, for the race where the channel drops between opening the form
 * and the server answering; that connection is this file's reading of the
 * doc, named as such, not a verbatim citation. A7 is not a business decision
 * needing a spec or JSDoc — a controlled `TextField`'s `value`/`onChange`
 * pair has exactly one correct behavior (the input reflects what changed
 * it), the same class of plumbing LabeledField.test.tsx already asserts for
 * `LabeledInput` without citing a spec value.
 *
 * NOT added: the generic `?? "Não foi possível criar o lembrete."` fallback
 * in `refusalCopy` (ReminderForm.tsx:97) for a refusal code outside
 * `REFUSALS`. No spec or JSDoc names that exact string — REFUSALS' own
 * comment documents its five known codes, not what happens off that list —
 * so asserting today's fallback text would read the oracle off the
 * implementation. Left untested on purpose; a human should supply the
 * expected copy (or confirm the fallback itself) before it is asserted.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FollowUpDueVehicle } from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
import { ReminderForm, defaultMoment } from "./ReminderForm.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

const AHEAD: FollowUpDueVehicle = {
  vehicleId: "v1",
  plate: "QRS-4B11",
  model: "Chevrolet Onix",
  returnId: "r1",
  returnDate: "2026-11-30T00:00:00.000Z",
  sourceServiceId: "s1",
};
const OVERDUE: FollowUpDueVehicle = { ...AHEAD, returnId: "r2", returnDate: "2026-05-30T00:00:00.000Z" };

let sent: { url: string; body: Record<string, unknown> }[] = [];

const server = setupServer(
  http.post("*/api/vehicle-returns/:returnId/reminders", async ({ request, params }) => {
    sent.push({ url: String(params.returnId), body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({
      reminderMessageId: "rem-1",
      vehicleReturnId: String(params.returnId),
      bodyTemplate: "Oi!",
      cancelledAt: null,
      scheduledMessages: [],
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  server.resetHandlers();
  sent = [];
});
afterAll(() => server.close());

function renderForm(
  vehicle: FollowUpDueVehicle,
  conversationId: string | null = "c1",
  { connected = true }: { connected?: boolean } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <AppProviders queryClient={queryClient}>
      <ReminderForm
        vehicle={vehicle}
        customerName="Ana Souza"
        conversationId={conversationId}
        connected={connected}
        now={NOW}
        onClose={() => {}}
      />
    </AppProviders>,
  );
  return { invalidate };
}

const confirm = () => screen.getByTestId("reminder-confirm");
const days = () => screen.getAllByLabelText("Dia") as HTMLInputElement[];

describe("ReminderForm", () => {
  it("opens with one moment, on the return date when that is still ahead", () => {
    renderForm(AHEAD);
    expect(days()).toHaveLength(1);
    expect(days()[0].value).toBe("2026-11-30");
  });

  it("opens an overdue return on a date ahead, not on its past return date", () => {
    // The server refuses a moment in the past, and this is the busiest section.
    renderForm(OVERDUE);
    expect(days()[0].value).toBe("2026-09-04");
    expect(days()[0].value > "2026-09-03").toBe(true);
  });

  it("posts one absolute trigger per moment", async () => {
    const user = userEvent.setup();
    renderForm(AHEAD);
    await user.click(screen.getByRole("button", { name: "+ Outro aviso" }));
    await user.click(screen.getByRole("button", { name: "+ Outro aviso" }));
    expect(days()).toHaveLength(3);

    await user.click(confirm());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe("r1");
    expect(sent[0].body.triggers).toHaveLength(3);
    expect((sent[0].body.triggers as { kind: string }[]).every((t) => t.kind === "absolute")).toBe(
      true,
    );
  });

  it("will not let the last moment be removed", async () => {
    const user = userEvent.setup();
    renderForm(AHEAD);
    expect(screen.getByLabelText("Remover aviso 1")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "+ Outro aviso" }));
    expect(screen.getByLabelText("Remover aviso 1")).toBeEnabled();
    await user.click(screen.getByLabelText("Remover aviso 2"));
    expect(days()).toHaveLength(1);
    expect(screen.getByLabelText("Remover aviso 1")).toBeDisabled();
  });

  it("omits bodyTemplate when the text is left blank, so the default composes", async () => {
    const user = userEvent.setup();
    renderForm(AHEAD);
    await user.click(confirm());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).not.toHaveProperty("bodyTemplate");
  });

  it("sends the typed text when there is one", async () => {
    const user = userEvent.setup();
    renderForm(AHEAD);
    await user.type(screen.getByTestId("reminder-text"), "Oi, Ana!");
    await user.click(confirm());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.bodyTemplate).toBe("Oi, Ana!");
  });

  it("blocks confirm when the customer has no conversation", () => {
    renderForm(AHEAD, null);
    expect(confirm()).toBeDisabled();
    expect(screen.getByText(/não tem conversa/)).toBeInTheDocument();
  });

  it("states a past-moment refusal in Portuguese, not as a code", async () => {
    server.use(
      http.post("*/api/vehicle-returns/:returnId/reminders", () =>
        HttpResponse.json({ error: "trigger_in_past", at: "2026-05-30T12:00:00.000Z" }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderForm(AHEAD);
    await user.click(confirm());

    expect(await screen.findByText(/Um dos avisos está no passado/)).toBeInTheDocument();
    expect(screen.queryByText(/trigger_in_past/)).toBeNull();
  });

  it("refreshes the queue so the row's summary updates without a reload", async () => {
    const user = userEvent.setup();
    const { invalidate } = renderForm(AHEAD);
    await user.click(confirm());

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["follow-up"] })),
    );
  });

  it("disables confirm and shows the disconnected banner when the channel is not connected", () => {
    renderForm(AHEAD, "c1", { connected: false });
    expect(screen.getByText("Envio pelo CRM indisponível.")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("states the disconnected refusal in Portuguese when the channel drops between opening and confirming", async () => {
    // Rendered connected (the form was usable when opened); the channel drops
    // before the server answers — the race the `connected` prop's own JSDoc
    // names as "a refusal", distinct from the render-time disabled state above.
    server.use(
      http.post("*/api/vehicle-returns/:returnId/reminders", () =>
        HttpResponse.json({ state: "DISCONNECTED" }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderForm(AHEAD);
    await user.click(confirm());

    expect(
      await screen.findByText("Envio pelo CRM indisponível. Reconecte o número para programar."),
    ).toBeInTheDocument();
  });

  it("posts an edited moment's new day and time, not the default", async () => {
    const user = userEvent.setup();
    renderForm(AHEAD);

    const day = days()[0]!;
    await user.clear(day);
    await user.type(day, "2026-12-15");
    const hour = screen.getByLabelText("Hora");
    await user.clear(hour);
    await user.type(hour, "14:30");

    await user.click(confirm());

    await waitFor(() => expect(sent).toHaveLength(1));
    const trigger = (sent[0]!.body.triggers as { at: string }[])[0]!;
    // toTrigger()'s own JSDoc: "Always absolute … the operator picked a
    // calendar day" — a local wall-clock day+hour converted to a UTC instant.
    // Computed independently here (not by re-running toTrigger) so the
    // assertion holds under whatever timezone this machine runs in, rather
    // than assuming one.
    const expected = new Date("2026-12-15T00:00:00");
    expected.setHours(14, 30, 0, 0);
    expect(trigger.at).toBe(expected.toISOString());
  });
});

describe("defaultMoment", () => {
  it("takes the return date while it is ahead", () => {
    expect(defaultMoment("2026-11-30T00:00:00.000Z", NOW).day).toBe("2026-11-30");
  });

  it("moves off the return date once it has arrived", () => {
    // Today is not "ahead": a moment earlier today is already past.
    expect(defaultMoment("2026-09-03T00:00:00.000Z", NOW).day).toBe("2026-09-04");
  });

  it("opens every new moment on the shown default hour", () => {
    expect(defaultMoment("2026-11-30T00:00:00.000Z", NOW)).toMatchObject({ hour: 9, minute: 0 });
  });
});
