/**
 * Test design (testing-strategy) — the clarification's way out (background-oil-research task 5.11)
 *
 * Setup: ConversasPage in AppProviders, MSW (`test/quote-dialog.ts`); the quote-options GET answers
 *   `needs_clarification`, the engine-pick POST records its body and answers per case, and the
 *   vehicle list answers the version the pick wrote. Shared code only, so the file runs in both
 *   variants (`pnpm test:web:antigravity`).
 *
 * Oracle: oil-quote "Ambiguous engine is clarification" — "Choosing a named engine appends it and
 *   re-reads the source", "A mismatch naming one engine offers it", "None of the named engines
 *   fits", "No engine named opens the vehicle's form", "A version too long for the field falls back
 *   to the form"; conversas "Correcting the version opens the form"; D24.2 (the buttons disabled
 *   after the first click, a 409 reads the quote again, a real button below the engines, the
 *   re-read's sentence with the counter and no range).
 *
 * Cells (the five variants are rows of one table)
 *   several named / mismatch one / mismatch several | one button per engine, named verbatim, the
 *     smaller fallback button; no POST before the click | a styled link; a request on open
 *   several none / mismatch none                     | "Corrigir versão do veículo" only     | engine buttons from nothing
 *   pick 1.8 (version XEi)        | POST { engine }, buttons disabled, "Versão … XEi 1.8 Dual VVT-i." and
 *                                   "Lendo a fonte para o motor 1.8 Dual VVT-i…", a timer, no range
 *   pick 1.6 (version XEi 1.0)    | "Versão do veículo corrigida para XEi 1.6." from the rail's list
 *   409                           | the quote read again                                 | a stale clarification
 *   422 version_too_long          | "Corrigir versão do veículo" offered                 | a dead end
 *   Corrigir versão (click, keyboard) | dialog closed, the drill-in form, Versão focused, no write
 */
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { useSelection } from "./selectionStore.js";
import { server } from "../test/msw/server.js";
import { openQuoteDialog, quoteVehicle } from "../test/quote-dialog.js";

const INTRO =
  "Escolha o motor deste veículo — a versão do cadastro é corrigida com ele e a fonte encontrada é lida de novo para esse motor.";
const NONE_OF_THESE = "Nenhum destes? Corrigir versão do veículo";
const CORRECT = "Corrigir versão do veículo";

function clarification(coverage: "several" | "mismatch", options: string[]) {
  return { status: "needs_clarification", coverage, options };
}

function enginePickResearching(engine: string) {
  return {
    status: "researching",
    requestedAt: "2026-10-01T12:00:00.000Z",
    now: "2026-10-01T12:00:04.000Z",
    expectedMinutes: { min: 1, max: 2 },
    queuePosition: 0,
    path: "engine_pick",
    engine,
    paused: null,
  };
}

/** Counts writes to the vehicle: an engine pick writes the version server-side, never from the web. */
function countVehicleWrites() {
  let writes = 0;
  server.use(
    http.patch("*/api/vehicles/:id", () => {
      writes += 1;
      return HttpResponse.json({}, { status: 500 });
    }),
  );
  return () => writes;
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("a clarification that names engines", () => {
  it.each([
    ["several, named", clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])],
    ["mismatch, one named", clarification("mismatch", ["2.0 Dynamic Force"])],
    ["mismatch, several named", clarification("mismatch", ["1.6 16V", "1.8 Dual VVT-i", "2.0 Dynamic Force"])],
  ])("%s: one button per engine, named verbatim, and the fallback is a real button", async (_name, body) => {
    const seq = await openQuoteDialog({ reads: [body] });

    expect(await within(seq.dialog).findByText(INTRO)).toBeInTheDocument();
    for (const engine of body.options) {
      const button = within(seq.dialog).getByRole("button", { name: engine });
      expect(button).toBeEnabled();
      // The 44 px target, on both variants (the antigravity floor).
      expect(getComputedStyle(button).minHeight).toBe("44px");
    }
    const fallback = within(seq.dialog).getByRole("button", { name: NONE_OF_THESE });
    expect(fallback.tagName).toBe("BUTTON");
    expect(within(seq.dialog).queryByRole("button", { name: CORRECT })).not.toBeInTheDocument();
    expect(seq.pickPosts).toEqual([]);
  });

  it("appends the engine, disables the buttons and shows the re-read with no range", async () => {
    const writes = countVehicleWrites();
    const seq = await openQuoteDialog({
      reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])],
      enginePick: (body) => ({ response: HttpResponse.json(enginePickResearching(String(body.engine))), version: "XEi 1.8 Dual VVT-i" }),
    });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    expect(seq.pickPosts).toEqual([{ engine: "1.8 Dual VVT-i" }]);
    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Lendo a fonte para o motor 1.8 Dual VVT-i…"));
    expect(within(seq.dialog).getByRole("status")).not.toHaveTextContent(/pode levar|minutos/);
    expect(within(seq.dialog).getByRole("timer")).toHaveTextContent(/^Pesquisando há /);
    // The corrected version, read from the rail's own vehicle list after the pick.
    expect(await within(seq.dialog).findByText("Versão do veículo corrigida para XEi 1.8 Dual VVT-i.")).toBeInTheDocument();
    expect(seq.vehicle().version).toBe("XEi 1.8 Dual VVT-i");
    expect(writes()).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Review of #198, finding 1: the version is read only from a list fetched after the pick.
  it("never shows the stale version: the sentence waits for the list fetched after the pick", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let picked = false;
    const seq = await openQuoteDialog({
      reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])],
      enginePick: () => {
        picked = true;
        return { response: HttpResponse.json(enginePickResearching("1.8 Dual VVT-i")) };
      },
    });
    // After the pick, the vehicle list is slow, and answers the corrected version only when released.
    server.use(
      http.get("*/api/conversations/:id/vehicles", async () => {
        if (!picked) return HttpResponse.json({ customerId: "cus-1", vehicles: [quoteVehicle] });
        await gate;
        return HttpResponse.json({ customerId: "cus-1", vehicles: [{ ...quoteVehicle, version: "XEi 1.8 Dual VVT-i" }] });
      }),
    );

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));
    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Lendo a fonte para o motor 1.8 Dual VVT-i…"));

    // The list the dialog already held still says "XEi": its sentence must not appear.
    expect(within(seq.dialog).queryByText(/Versão do veículo corrigida/)).not.toBeInTheDocument();
    release();
    expect(await within(seq.dialog).findByText("Versão do veículo corrigida para XEi 1.8 Dual VVT-i.")).toBeInTheDocument();
    expect(within(seq.dialog).queryByText("Versão do veículo corrigida para XEi.")).not.toBeInTheDocument();
  });

  it("re-reads the rail's vehicle list on a 409 version_changed", async () => {
    let vehicleReads = 0;
    const seq = await openQuoteDialog({
      reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])],
      enginePick: () => ({ response: HttpResponse.json({ reason: "version_changed" }, { status: 409 }) }),
    });
    server.use(
      http.get("*/api/conversations/:id/vehicles", () => {
        vehicleReads += 1;
        return HttpResponse.json({ customerId: "cus-1", vehicles: [quoteVehicle] });
      }),
    );
    const before = vehicleReads;

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    await waitFor(() => expect(vehicleReads).toBeGreaterThan(before));
    await waitFor(() => expect(seq.gets()).toBe(2));
  });

  // Review of #198, finding 5: a failure the dialog cannot act on says so and offers the engines again.
  it.each([
    ["a 500", () => ({ response: HttpResponse.json({}, { status: 500 }) })],
    ["a network error", () => ({ response: HttpResponse.error() })],
  ])("says the version could not be corrected on %s, and re-enables the buttons", async (_name, enginePick) => {
    const seq = await openQuoteDialog({ reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])], enginePick });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Não foi possível corrigir a versão. Tente de novo."));
    expect(within(seq.dialog).getByRole("button", { name: "1.8 Dual VVT-i" })).toBeEnabled();
    expect(within(seq.dialog).getByRole("button", { name: "2.0 Dynamic Force" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables every engine button while the pick is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seq = await openQuoteDialog({ reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])] });
    server.use(
      http.post("*/api/vehicles/:id/oil-research/engine-pick", async () => {
        await gate;
        return HttpResponse.json(enginePickResearching("1.8 Dual VVT-i"));
      }),
    );

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    await waitFor(() => expect(within(seq.dialog).getByRole("button", { name: "2.0 Dynamic Force" })).toBeDisabled());
    expect(within(seq.dialog).getByRole("button", { name: "1.8 Dual VVT-i" })).toBeDisabled();
    release();
    await waitFor(() => expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Lendo a fonte para o motor 1.8 Dual VVT-i…"));
  });

  it("replaces a different engine, as the rail's list shows it", async () => {
    const seq = await openQuoteDialog({
      vehicle: { ...quoteVehicle, version: "XEi 1.0" },
      reads: [clarification("mismatch", ["1.6"])],
      enginePick: () => ({ response: HttpResponse.json(enginePickResearching("1.6")), version: "XEi 1.6" }),
    });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.6" }));

    expect(await within(seq.dialog).findByText("Versão do veículo corrigida para XEi 1.6.")).toBeInTheDocument();
    expect(within(seq.dialog).getByRole("status")).toHaveTextContent("Lendo a fonte para o motor 1.6…");
  });

  it.each(["not_clarification", "engine_not_named", "version_changed"])("reads the quote again on a 409 %s", async (reason) => {
    const seq = await openQuoteDialog({
      reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"]), { status: "no_spec", reason: "no_source" }],
      enginePick: () => ({ response: HttpResponse.json({ reason }, { status: 409 }) }),
    });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    await waitFor(() => expect(seq.gets()).toBe(2));
    expect(await within(seq.dialog).findByText(/Não encontramos o óleo indicado/)).toBeInTheDocument();
  });

  it("offers Corrigir versão do veículo on a 422 version_too_long", async () => {
    const seq = await openQuoteDialog({
      reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])],
      enginePick: () => ({ response: HttpResponse.json({ error: "version_too_long" }, { status: 422 }) }),
    });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: "1.8 Dual VVT-i" }));

    expect(await within(seq.dialog).findByRole("button", { name: CORRECT })).toBeInTheDocument();
    expect(seq.gets()).toBe(1);
  });
});

describe("a clarification that names no engine", () => {
  it.each([
    ["several, none named", clarification("several", [])],
    ["mismatch, none named", clarification("mismatch", [])],
  ])("%s: offers Corrigir versão do veículo and no engine button", async (_name, body) => {
    const seq = await openQuoteDialog({ reads: [body] });

    expect(await within(seq.dialog).findByRole("button", { name: CORRECT })).toBeInTheDocument();
    expect(within(seq.dialog).queryByText(INTRO)).not.toBeInTheDocument();
    expect(within(seq.dialog).queryByRole("button", { name: NONE_OF_THESE })).not.toBeInTheDocument();
    // Still "Buscar novamente" (D24: all five variants keep it).
    expect(within(seq.dialog).getByRole("button", { name: "Buscar novamente" })).toBeInTheDocument();
  });
});

describe("Corrigir versão do veículo", () => {
  it("closes the dialog and opens the drill-in's form with the version focused, writing nothing", async () => {
    const writes = countVehicleWrites();
    const seq = await openQuoteDialog({ reads: [clarification("several", [])] });

    await seq.user.click(await within(seq.dialog).findByRole("button", { name: CORRECT }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Montar orçamento/ })).not.toBeInTheDocument());
    const drillIn = await screen.findByRole("region", { name: "Veículo" });
    await waitFor(() => expect(within(drillIn).getByLabelText("Versão")).toHaveFocus());
    expect(within(drillIn).getByLabelText("Versão")).toHaveValue("XEi");
    expect(writes()).toBe(0);
    expect(seq.pickPosts).toEqual([]);
  });

  it("reaches the fallback below the engines by keyboard", async () => {
    const seq = await openQuoteDialog({ reads: [clarification("several", ["1.8 Dual VVT-i", "2.0 Dynamic Force"])] });
    const fallback = await within(seq.dialog).findByRole("button", { name: NONE_OF_THESE });

    for (let step = 0; step < 15 && document.activeElement !== fallback; step += 1) {
      await seq.user.tab();
    }
    expect(fallback).toHaveFocus();
    await seq.user.keyboard("{Enter}");

    const drillIn = await screen.findByRole("region", { name: "Veículo" });
    await waitFor(() => expect(within(drillIn).getByLabelText("Versão")).toHaveFocus());
    expect(seq.pickPosts).toEqual([]);
  });
});
