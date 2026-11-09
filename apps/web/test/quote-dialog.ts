/**
 * Opens the Montar orçamento dialog on a mocked Conversas page, for the dialog's dead-end suites
 * (background-oil-research tasks 5.10–5.12). The quote-options GET answers from `reads` in order,
 * the last repeating; the two dead-end POSTs record their bodies and answer from the case's own
 * responder; the vehicle list answers the vehicle as the last engine pick left it.
 *
 * A plain `.ts` module (the test tsconfig collects `test/**\/*.ts`), so the tree is built with
 * `createElement`.
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { ConversationSummary, Vehicle } from "@select-lub/shared-types";
import { AppProviders } from "../src/AppProviders.js";
import { ConversasPage } from "../src/ConversasPage.js";
import { server } from "./msw/server.js";

export const quoteConversation: ConversationSummary = {
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

/** The canvas's sample car, "Toyota Corolla XEi 2019" (D17's sign-off). */
export const quoteVehicle: Vehicle = {
  id: "veh-a",
  customerId: "cus-1",
  omieId: null,
  plate: "ABC1D23",
  make: "Toyota",
  model: "Corolla",
  version: "XEi",
  year: 2019,
  odometerKm: 42300,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** A recorded POST: its parsed JSON body. */
export type RecordedPost = Record<string, unknown>;

export type QuoteDialogOptions = {
  reads: object[];
  vehicle?: Vehicle;
  /** `POST /vehicles/:id/oil-fill-volume`; defaults to a stored 201. */
  fillVolume?: (body: RecordedPost) => Response;
  /**
   * `POST /vehicles/:id/oil-research/engine-pick`. Answering, it may name the version the pick
   * wrote (`version`), which the vehicle list then shows.
   */
  enginePick?: (body: RecordedPost) => { response: Response; version?: string };
};

/**
 * Renders the page, selects the conversation and opens the dialog on the first vehicle.
 *
 * @returns The user, the dialog, the GET count and the recorded POST bodies.
 */
export async function openQuoteDialog(options: QuoteDialogOptions) {
  let gets = 0;
  let vehicle = options.vehicle ?? quoteVehicle;
  const fillPosts: RecordedPost[] = [];
  const pickPosts: RecordedPost[] = [];
  const quotePosts: RecordedPost[] = [];
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([quoteConversation])),
    http.get("*/api/conversations/:id/vehicles", () => HttpResponse.json({ customerId: "cus-1", vehicles: [vehicle] })),
    http.get("*/api/vehicles/:id/services", () => HttpResponse.json([])),
    http.get("*/api/vehicles/:id/quote-options", () => {
      const body = options.reads[Math.min(gets, options.reads.length - 1)];
      gets += 1;
      return HttpResponse.json(body);
    }),
    http.post("*/api/vehicles/:id/oil-fill-volume", async ({ request }) => {
      const body = (await request.json()) as RecordedPost;
      fillPosts.push(body);
      return options.fillVolume
        ? options.fillVolume(body)
        : HttpResponse.json({ liters: body.liters, recordedBy: "Atendente", recordedAt: "2026-10-01T12:00:00.000Z" }, { status: 201 });
    }),
    http.post("*/api/vehicles/:id/oil-research/engine-pick", async ({ request }) => {
      const body = (await request.json()) as RecordedPost;
      pickPosts.push(body);
      const answer = options.enginePick?.(body) ?? { response: HttpResponse.json({}, { status: 500 }) };
      if (answer.version !== undefined) vehicle = { ...vehicle, version: answer.version };
      return answer.response;
    }),
    http.post("*/api/vehicles/:id/quotes", async ({ request }) => {
      quotePosts.push((await request.json()) as RecordedPost);
      return HttpResponse.json({}, { status: 500 });
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    createElement(MemoryRouter, null, createElement(AppProviders, { queryClient, children: createElement(ConversasPage) })),
  );
  // Under fake timers, user-event's own delays advance the fake clock.
  const user = vi.isFakeTimers() ? userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }) : userEvent.setup();
  await user.click(await screen.findByText("Roberto"));
  await user.click(await screen.findByRole("button", { name: "Montar orçamento" }));
  const dialog = await screen.findByRole("dialog", { name: /Montar orçamento/ });
  return {
    user,
    dialog,
    gets: () => gets,
    fillPosts,
    pickPosts,
    quotePosts,
    vehicle: () => vehicle,
  };
}
