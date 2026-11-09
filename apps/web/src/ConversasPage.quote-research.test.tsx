/**
 * Test design (testing-strategy) — the quote dialog's research block in place (background-oil-research
 * task 5.3)
 *
 * Setup: ConversasPage in AppProviders, MSW; the quote-options GET answers from a list in order,
 *   the last repeating. The polling cases wait on the real 3 s interval: the interval is part of
 *   the behaviour under test. The loading → research → options case drives that interval with
 *   `vi.useFakeTimers({ shouldAdvanceTime: true })` instead, advancing exactly one poll: on the
 *   real clock it raced a 6 s wait against what were two polls (the held read answered without
 *   consuming its entry) and failed about 2 runs in 9. Shared code only, so the file runs in both
 *   variants (`pnpm test:web:antigravity`).
 *
 * Oracle: design.md D17 — "One status container" (one `role="status"` element stays mounted for
 *   the dialog's lifetime and only its text changes; the counter is `role="timer"` outside it; MUI
 *   `Alert` is not used, since its role is `alert`); "New data while editing" (keep the shown row
 *   and offer "Chegaram dados novos de {data}." with "Atualizar"; swap silently when nothing was
 *   edited); "Filters that arrive later are priced in without a click"; "Buscar novamente" is a
 *   keyboard-reachable button with a 44 px target. The oil-quote delta's scenarios "The ticking time
 *   is not announced", "New data does not replace an edited message", "Filters that arrive after the
 *   options are priced in".
 *
 * Cells
 *   loading → researching → options | the same status node throughout, one per dialog, no alert | a region per branch
 *   price edited, newer row arrives | old price kept, the banner; Atualizar shows the new row  | the edit silently lost
 *   nothing edited, newer row       | new date shown, no banner                                | a banner nobody needs
 *   filters pending → cached        | untouched card re-priced 200,00 → 277,00, no click        | a stale oil-only price
 *   keyboard                        | Tab reaches Buscar novamente, Enter POSTs; min-height 44 px | a div styled as a button
 */
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogItemFixture,
  lubricantDetailFixture,
  type ConversationSummary,
  type QuoteFilterCard,
  type Vehicle,
} from "@select-lub/shared-types";
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

/** 50,00 per litre × 4 L = 200,00: far from either filter price, so a missed filter shows. */
const oilCard = { ...catalogItemFixture, lubricant: lubricantDetailFixture, price: 50 };

function filterCard(id: string, filterType: "OLEO" | "COMBUSTIVEL", partNumber: string, price: number): QuoteFilterCard {
  return {
    id,
    brand: "Tecfil",
    description: filterType === "OLEO" ? "Filtro de óleo" : "Filtro de combustível",
    price,
    stock: 0,
    active: true,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
    filter: { catalogItemId: id, filterType, partNumber },
  };
}

const CACHED_FILTERS = {
  source: "cached",
  consultedAt: "2026-09-03T18:00:00.000Z",
  application: { manufacturer: "TOYOTA", vehicle: "COROLLA", engine: "1.8" },
  oil: { status: "matched", candidates: [filterCard("cat-oil", "OLEO", "PEL108", 32)] },
  fuel: { status: "matched", candidates: [filterCard("cat-fuel", "COMBUSTIVEL", "GI50/7", 45)] },
};

const PENDING_FILTERS = {
  source: "pending",
  stopped: false,
  consultedAt: null,
  application: null,
  oil: { status: "unavailable" },
  fuel: { status: "unavailable" },
};

const MANUAL = {
  sourcePublisher: "Toyota",
  sourceDocument: "Manual do proprietário Corolla 2019",
  sourcePage: "p. 412",
  sourceAuthority: 1,
  sourceUrl: null,
};

function optionsBody(consultedAt: string, filters: object = CACHED_FILTERS, extra: object = {}) {
  return {
    status: "options",
    viscosityGrades: ["5W-30"],
    viscosity: "5W-30",
    classification: "API SN",
    fillLiters: 4,
    fillKind: "em_servico",
    fillCondition: "with_filter",
    ...MANUAL,
    gradeSources: [{ grade: "5W-30", ...MANUAL }],
    litersSource: MANUAL,
    consultedAt,
    options: [oilCard],
    filters,
    ...extra,
  };
}

const TIMING = {
  requestedAt: "2026-09-26T17:00:00.000Z",
  now: "2026-09-26T17:00:41.000Z",
  expectedMinutes: { min: 1, max: 5 },
  queuePosition: 0,
  path: "search",
  paused: null,
};

/**
 * Opens the dialog with GETs answered from `reads` in order (the last repeats). A `null` entry
 * holds that read until `release()` — the loading state — and answers with the entry after it,
 * which it consumes, so the next read answers the one after that.
 */
async function openSequence(reads: Array<object | null>, onPost?: () => void | Promise<void>, postBody: object = { ...optionsBody("2026-09-12T12:00:00.000Z"), refresh: TIMING }) {
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get("*/api/conversations", () => HttpResponse.json([conversation])),
    http.get("*/api/conversations/:id/vehicles", () => HttpResponse.json({ customerId: "cus-1", vehicles: [vehicle] })),
    http.get("*/api/vehicles/:id/quote-options", async () => {
      const index = Math.min(gets, reads.length - 1);
      gets += 1;
      if (reads[index] === null) {
        gets += 1;
        await gate;
        return HttpResponse.json(reads[index + 1]);
      }
      return HttpResponse.json(reads[index]);
    }),
    http.post("*/api/vehicles/:id/oil-research/refetch", async () => {
      await onPost?.();
      return HttpResponse.json(postBody);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <AppProviders queryClient={queryClient}>
        <ConversasPage />
      </AppProviders>
    </MemoryRouter>,
  );
  // Under fake timers, user-event's own delays advance the fake clock.
  const user = vi.isFakeTimers() ? userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }) : userEvent.setup();
  await user.click(await screen.findByText("Roberto"));
  await user.click(await screen.findByRole("button", { name: "Montar orçamento" }));
  const dialog = await screen.findByRole("dialog", { name: /Montar orçamento/ });
  return { user, dialog, release, gets: () => gets };
}

afterEach(() => {
  vi.useRealTimers();
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("the quote dialog's status region", () => {
  it(
    "keeps one status element from loading through research to the options, the timer outside it",
    async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // null: the first read is held (loading); it then answers researching, and the poll options.
      const seq = await openSequence([null, { status: "researching", ...TIMING }, optionsBody("2026-09-12T12:00:00.000Z")]);
      const loading = within(seq.dialog).getByRole("status");
      expect(loading).toHaveTextContent("Carregando opções de orçamento…");

      seq.release();
      await waitFor(() =>
        expect(within(seq.dialog).getByRole("status")).toHaveTextContent(
          "Procurando lubrificante compatível — pode levar entre 1 e 5 minutos.",
        ),
      );
      const researching = within(seq.dialog).getByRole("status");
      const timer = within(seq.dialog).getByRole("timer");
      expect(within(seq.dialog).getAllByRole("status")).toHaveLength(1);
      expect(researching.contains(timer)).toBe(false);
      expect(timer).toHaveTextContent(/^Pesquisando há /);
      expect(within(seq.dialog).queryByRole("alert")).not.toBeInTheDocument();

      // Exactly one poll interval (D17: 3 s while researching) brings the options.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 12/09/2026."));
      expect(seq.gets()).toBe(3);
      const settled = within(seq.dialog).getByRole("status");

      // The same node throughout: only its text changed, so a screen reader announces each change.
      expect(researching).toBe(loading);
      expect(settled).toBe(loading);
      expect(within(seq.dialog).getAllByRole("status")).toHaveLength(1);
      expect(within(seq.dialog).queryByRole("timer")).not.toBeInTheDocument();
      expect(within(seq.dialog).queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("keeps an edited quote when a newer row arrives, and shows it on Atualizar", { timeout: 20_000 }, async () => {
    const seq = await openSequence([
      optionsBody("2026-09-12T12:00:00.000Z", CACHED_FILTERS, { refresh: TIMING }),
      optionsBody("2026-09-27T12:00:00.000Z"),
    ]);
    const price = await within(seq.dialog).findByLabelText("Preço");
    await waitFor(() => expect(price).toHaveValue("277,00"));
    await seq.user.clear(price);
    await seq.user.type(price, "300,00");

    // The persistent status says what changed (review of #196), so a screen reader hears it.
    await waitFor(
      () => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Chegaram dados novos de 27/09/2026."),
      { timeout: 6_000 },
    );
    expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("300,00");
    // The shown row's date stays on its own line.
    expect(within(seq.dialog).getByText("Dados consultados em 12/09/2026.")).toBeInTheDocument();
    // The search that ended is no longer said to be running.
    expect(within(seq.dialog).queryByText(/Buscando dados novos/)).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("timer")).not.toBeInTheDocument();

    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Atualizar" }));

    expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 27/09/2026.");
    expect(within(seq.dialog).queryByText(/Chegaram dados novos/)).not.toBeInTheDocument();
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("277,00"));
  });

  it("swaps to a newer row silently when nothing was edited", { timeout: 20_000 }, async () => {
    const seq = await openSequence([
      optionsBody("2026-09-12T12:00:00.000Z", CACHED_FILTERS, { refresh: TIMING }),
      optionsBody("2026-09-27T12:00:00.000Z"),
    ]);

    await waitFor(
      () => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Dados consultados em 27/09/2026."),
      { timeout: 6_000 },
    );
    expect(within(seq.dialog).queryByText(/Chegaram dados novos/)).not.toBeInTheDocument();
  });

  it("prices filters that arrive later into the untouched card, without a click", { timeout: 20_000 }, async () => {
    const seq = await openSequence([
      optionsBody("2026-09-12T12:00:00.000Z", PENDING_FILTERS),
      optionsBody("2026-09-12T12:00:00.000Z"),
    ]);
    expect(
      await within(seq.dialog).findByText("Ainda estamos consultando os filtros na Tecfil — por enquanto, nenhum filtro entra no preço."),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("200,00"));

    await waitFor(() => expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("277,00"), { timeout: 6_000 });
    expect(within(seq.dialog).queryByText(/Ainda estamos consultando/)).not.toBeInTheDocument();
  });

  it("reaches Buscar novamente by keyboard, with a 44 px target", async () => {
    let posts = 0;
    const seq = await openSequence([{ status: "no_spec", reason: "no_source" }], () => {
      posts += 1;
    });
    const button = await within(seq.dialog).findByRole("button", { name: "Buscar novamente" });

    for (let step = 0; step < 10 && document.activeElement !== button; step += 1) {
      await seq.user.tab();
    }
    expect(button).toHaveFocus();
    await seq.user.keyboard("{Enter}");

    await waitFor(() => expect(posts).toBe(1));
    expect(getComputedStyle(button).minHeight).toBe("44px");
  });

  // Review of #196, finding 1: a refresh answer is never held, so its progress shows.
  it("shows the new search after Buscar novamente on a held row", { timeout: 20_000 }, async () => {
    // The POST answers with the server's latest row — the held one — plus the new search: a
    // different row from the shown one, which is exactly the read the hold would swallow.
    const seq = await openSequence(
      [optionsBody("2026-09-12T12:00:00.000Z", CACHED_FILTERS, { refresh: TIMING }), optionsBody("2026-09-27T12:00:00.000Z")],
      undefined,
      optionsBody("2026-09-27T12:00:00.000Z", CACHED_FILTERS, { refresh: TIMING }),
    );
    const price = await within(seq.dialog).findByLabelText("Preço");
    await waitFor(() => expect(price).toHaveValue("277,00"));
    await seq.user.clear(price);
    await seq.user.type(price, "300,00");
    await waitFor(
      () => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Chegaram dados novos de 27/09/2026."),
      { timeout: 6_000 },
    );

    await seq.user.click(within(seq.dialog).getByRole("button", { name: "Buscar novamente" }));

    await waitFor(() =>
      expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Buscando dados novos — pode levar entre 1 e 5 minutos."),
    );
    expect(within(seq.dialog).getByRole("timer")).toHaveTextContent(/^Pesquisando há /);
    expect(within(seq.dialog).getByLabelText("Preço")).toHaveValue("300,00");
  });

  // Review of #196, finding 2: the button keeps its place and is never `disabled`, so focus stays.
  it("keeps focus on Buscar novamente while the POST is pending and after the view becomes a refresh", { timeout: 20_000 }, async () => {
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seq = await openSequence([optionsBody("2026-09-12T12:00:00.000Z")], async () => {
      posts += 1;
      await gate;
    });
    const button = await within(seq.dialog).findByRole("button", { name: "Buscar novamente" });
    button.focus();

    await seq.user.keyboard("{Enter}");
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(document.activeElement).toBe(button);
    // jsdom keeps focus on a `disabled` button where a browser drops it, so the mechanism is
    // pinned directly: the pending button is never `disabled`.
    expect(button).not.toBeDisabled();
    // A second Enter while pending sends nothing.
    await seq.user.keyboard("{Enter}");
    release();

    await waitFor(() =>
      expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Buscando dados novos — pode levar entre 1 e 5 minutos."),
    );
    expect(document.activeElement).toBe(button);
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(posts).toBe(1);
  });

  // Review of #196, finding 4: the filter warnings arrive with the cards, never as an alert.
  it.each([
    ["unavailable", { ...CACHED_FILTERS, source: "unavailable", consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } }, "Não foi possível consultar os filtros na Tecfil — nenhum filtro foi incluído no preço."],
    ["unmatched", { ...CACHED_FILTERS, source: "unmatched", unmatchedField: "engine", consultedAt: null, application: null, oil: { status: "unavailable" }, fuel: { status: "unavailable" } }, "Veículo não encontrado no catálogo da Tecfil (motor) — nenhum filtro foi incluído no preço."],
    ["per type", { ...CACHED_FILTERS, fuel: { status: "no_fitment" } }, "A Tecfil não lista filtro de combustível para este veículo."],
  ])("shows the %s filter warning with no alert role", async (_name, filters, text) => {
    const seq = await openSequence([optionsBody("2026-09-12T12:00:00.000Z", filters)]);

    expect(await within(seq.dialog).findByText(text)).toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(seq.dialog).getAllByRole("status")).toHaveLength(1);
  });
});
