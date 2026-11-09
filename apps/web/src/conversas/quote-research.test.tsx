/**
 * Test design (testing-strategy) — the research clock and the status region (background-oil-research
 * tasks 5.2 and 5.3)
 *
 * SUT: `useNow` / `useServerNow` (src/useNow.ts) through `QuoteStatusRegion`
 *   (conversas/quote-research.tsx), rendered directly — the region needs no query client — in the
 *   app theme. Shared by both variants with no variant code, so the same file runs under
 *   `pnpm test:web:antigravity`.
 *
 * Oracle: design.md D14 ("Elapsed time is anchored on the server": the offset computed once per
 *   response, ticking from it) and D17's copy table, verbatim; the oil-quote delta's "The dialog
 *   shows research progress while an identity is researched" scenarios: the warning gives the range
 *   and the time searching; reopening does not reset the time; past the range it says it is taking
 *   longer; a research that waited its turn is not late; an hour or more in hours; no worker running;
 *   a retry shows no range; a paused new search says why.
 *
 * Clock: `vi.useFakeTimers({ shouldAdvanceTime: true })`, the repo's pattern for clock-driven UI.
 * The browser clock is set 3 minutes BEHIND the server's `now` in every case, so a counter that
 * ignored the offset would read 3 minutes short — far from every expected value.
 *
 * Axes
 *   C1 elapsed since requestedAt — 0:38 / 0:59 / 2:15 / 8:00 (of 9–11) / 59:59 / 60:00 / 65:00 / past Y
 *   C2 paused — none / retrying / stopped
 *   C3 kind — researching / row+refresh / row / outcome
 *   C4 path & queue — search, 0 ahead / manual / 1 ahead / 2 ahead
 *
 * Cells
 *   2:15, not paused        | range + "Pesquisando há 2 min 15 s", then +1 s     | the browser clock, not the server's
 *   remount 60 s later      | counter continues from requestedAt                 | reset to 0 on reopen
 *   59 s / 59:59 / 60:00    | "59 s" / "59 min 59 s" / "1 h 0 min"               | the wrong unit at a boundary
 *   stopped                 | "Na fila há …", no range                           | "Pesquisando há" while nothing searches
 *   retrying                | "Pesquisando há …", the retry time, no range       | a range while paused
 *   past Y → "demorando"    | the sentence switches, on the tick                 | the range shown late for ever
 *   8:00 of 9–11            | the range, not "demorando"                         | late on start after a queue
 *   manual, paused / not    | the manual line only when not paused               | the line under a pause
 *   queue 1 / 2             | singular / plural                                   | "1 pesquisas"
 *   refresh variants        | each refresh sentence, and the date line below     | the research copy on a row
 *   row / outcome           | the date beside Buscar novamente; outcome + button | the button missing
 *   refetch failed          | the POST error copy, button enabled                | a silent failure
 *   a11y                    | one role=status, role=timer outside it, no alert   | the timer inside the live region
 */
import { ThemeProvider } from "@mui/material/styles";
import { act, render, screen } from "@testing-library/react";
import type { ResearchTiming } from "@select-lub/shared-types";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppTheme } from "../theme.js";
import { QuoteStatusRegion, type QuoteStatusView } from "./quote-research.js";

/** The server's instant the response was answered at. */
const SERVER_NOW = Date.parse("2026-09-26T17:02:15.000Z");
/** The browser's clock at that moment: 3 minutes behind the server. */
const CLIENT_NOW = SERVER_NOW - 3 * 60_000;

/** A research under way, answered at {@link SERVER_NOW}, requested `elapsedS` seconds before it. */
function timing(elapsedS: number, overrides: Partial<ResearchTiming> = {}): ResearchTiming {
  return {
    requestedAt: new Date(SERVER_NOW - elapsedS * 1_000).toISOString(),
    now: new Date(SERVER_NOW).toISOString(),
    expectedMinutes: { min: 1, max: 3 },
    queuePosition: 0,
    path: "search",
    paused: null,
    ...overrides,
  };
}

function inTheme(node: ReactElement) {
  return <ThemeProvider theme={createAppTheme("yellow-cta")}>{node}</ThemeProvider>;
}

/** Renders the region as the dialog does, with the response received "now" on the browser clock. */
function renderRegion(view: QuoteStatusView, extra: Partial<Parameters<typeof QuoteStatusRegion>[0]> = {}) {
  return render(inTheme(<QuoteStatusRegion view={view} receivedAt={CLIENT_NOW} {...extra} />));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(CLIENT_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the research clock (task 5.2)", () => {
  it("ticks every second from the server's clock", async () => {
    renderRegion({ kind: "researching", timing: timing(135) });

    expect(screen.getByRole("status")).toHaveTextContent("Procurando lubrificante compatível — pode levar entre 1 e 3 minutos.");
    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 2 min 15 s");
    await tick(1_000);
    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 2 min 16 s");
  });

  it("continues from requestedAt when the dialog is reopened a minute later", async () => {
    const view: QuoteStatusView = { kind: "researching", timing: timing(135) };
    const first = renderRegion(view);
    first.unmount();
    await tick(60_000);

    // The same cached response (the same receivedAt): the anchor is requestedAt, not the remount.
    renderRegion(view);

    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 3 min 15 s");
  });

  // Review of #196, nit 6: a poll's fresh offset can sit a little behind the previous one.
  it("never steps back below a value already shown for the same requestedAt", async () => {
    const view: QuoteStatusView = { kind: "researching", timing: timing(135) };
    const { rerender } = renderRegion(view);
    await tick(2_000);
    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 2 min 17 s");

    // The next response says the same server instant but arrived 4 s later on the browser's
    // clock: taken alone, its offset would read 2 min 13 s.
    rerender(inTheme(<QuoteStatusRegion view={{ kind: "researching", timing: timing(135) }} receivedAt={CLIENT_NOW + 4_000} />));

    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 2 min 17 s");
  });

  it.each([
    [59, "Pesquisando há 59 s"],
    [59 * 60 + 59, "Pesquisando há 59 min 59 s"],
    [60 * 60, "Pesquisando há 1 h 0 min"],
    [65 * 60, "Pesquisando há 1 h 5 min"],
  ])("formats %i s as %j", (elapsedS, text) => {
    renderRegion({ kind: "researching", timing: timing(elapsedS, { expectedMinutes: { min: 1, max: 90 } }) });

    expect(screen.getByRole("timer")).toHaveTextContent(text);
  });

  it("reads Na fila há while research is stopped, and shows no range", () => {
    renderRegion({ kind: "researching", timing: timing(72 * 60, { paused: { reason: "stopped" } }) });

    expect(screen.getByRole("status")).toHaveTextContent("A pesquisa automática não está rodando agora; o pedido fica na fila.");
    expect(screen.getByRole("timer")).toHaveTextContent("Na fila há 1 h 12 min");
    expect(screen.queryByText(/pode levar entre/)).not.toBeInTheDocument();
  });

  it("keeps Pesquisando há under a retry, with its São Paulo time and no range", () => {
    renderRegion({
      kind: "researching",
      timing: timing(290, { paused: { reason: "retrying", retryAt: "2026-09-26T17:35:00.000Z" } }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("A última tentativa falhou; vamos tentar de novo às 14:35.");
    expect(screen.getByRole("timer")).toHaveTextContent("Pesquisando há 4 min 50 s");
    expect(screen.queryByText(/pode levar entre/)).not.toBeInTheDocument();
  });
});

describe("the research block (task 5.3)", () => {
  it("switches to demorando mais que o normal once the time passes Y, on the tick", async () => {
    renderRegion({ kind: "researching", timing: timing(3 * 60 - 1) });
    expect(screen.getByRole("status")).toHaveTextContent("Procurando lubrificante compatível — pode levar entre 1 e 3 minutos.");

    await tick(2_000);

    expect(screen.getByRole("status")).toHaveTextContent("Procurando lubrificante compatível. Está demorando mais que o normal.");
  });

  it("is not late when a research that waited eight minutes has just started, estimated 9–11", () => {
    renderRegion({ kind: "researching", timing: timing(8 * 60, { expectedMinutes: { min: 9, max: 11 } }) });

    expect(screen.getByRole("status")).toHaveTextContent("Procurando lubrificante compatível — pode levar entre 9 e 11 minutos.");
  });

  it("does not switch to demorando while paused", () => {
    renderRegion({ kind: "researching", timing: timing(20 * 60, { paused: { reason: "stopped" } }) });

    expect(screen.queryByText(/demorando mais que o normal/)).not.toBeInTheDocument();
  });

  it.each([
    [null, true],
    [{ reason: "stopped" as const }, false],
    [{ reason: "retrying" as const, retryAt: "2026-09-26T17:35:00.000Z" }, false],
  ])("adds the manual line on the manual path when paused is %j: %s", (paused, shown) => {
    renderRegion({ kind: "researching", timing: timing(185, { path: "manual", paused }) });

    const line = screen.queryByText("Encontramos o manual da montadora e estamos lendo o documento.");
    if (shown) expect(line).toBeInTheDocument();
    else expect(line).not.toBeInTheDocument();
  });

  it.each([
    [0, null],
    [1, "Há 1 pesquisa na frente."],
    [2, "Há 2 pesquisas na frente."],
  ])("with %i ahead says %j", (ahead, text) => {
    renderRegion({ kind: "researching", timing: timing(41, { queuePosition: ahead, expectedMinutes: { min: 5, max: 9 } }) });

    expect(screen.queryByText(/na frente/)?.textContent ?? null).toBe(text);
  });

  it.each([
    [timing(65), "Buscando dados novos — pode levar entre 1 e 3 minutos.", "Pesquisando há 1 min 5 s"],
    [timing(390), "Buscando dados novos. Está demorando mais que o normal.", "Pesquisando há 6 min 30 s"],
    [timing(1_500, { paused: { reason: "stopped" } }), "Nova busca na fila, mas a pesquisa automática não está rodando agora.", "Na fila há 25 min 0 s"],
    [
      timing(170, { paused: { reason: "retrying", retryAt: "2026-09-26T17:35:00.000Z" } }),
      "A nova busca falhou; vamos tentar de novo às 14:35.",
      "Pesquisando há 2 min 50 s",
    ],
  ])("says a new search over a shown row: %#", (refresh, sentence, counter) => {
    const onRefetch = vi.fn();
    renderRegion(
      { kind: "row", dateText: "Dados consultados em 12/09/2026.", refresh },
      { refetch: { onRefetch, pending: false, failed: false } },
    );

    expect(screen.getByRole("status")).toHaveTextContent(sentence);
    expect(screen.getByRole("timer")).toHaveTextContent(counter);
    // The row's date stays under the search, with Buscar novamente beside it.
    expect(screen.getByText("Dados consultados em 12/09/2026.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeEnabled();
  });

  it("says the row's date beside Buscar novamente, with no counter", () => {
    renderRegion(
      { kind: "row", dateText: "Dados consultados em 12/09/2026." },
      { refetch: { onRefetch: vi.fn(), pending: false, failed: false } },
    );

    expect(screen.getByRole("status")).toHaveTextContent("Dados consultados em 12/09/2026.");
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("says an outcome with Buscar novamente inside it", () => {
    renderRegion(
      { kind: "outcome", text: "Não conseguimos concluir a pesquisa de lubrificante deste veículo." },
      { refetch: { onRefetch: vi.fn(), pending: false, failed: false } },
    );

    expect(screen.getByRole("status")).toHaveTextContent("Não conseguimos concluir a pesquisa de lubrificante deste veículo.");
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeInTheDocument();
  });

  it("offers no Buscar novamente while research runs with no row", () => {
    renderRegion({ kind: "researching", timing: timing(41) });

    expect(screen.queryByRole("button", { name: "Buscar novamente" })).not.toBeInTheDocument();
  });

  it("says the POST failed and keeps the button enabled", () => {
    renderRegion(
      { kind: "row", dateText: "Dados consultados em 12/09/2026." },
      { refetch: { onRefetch: vi.fn(), pending: false, failed: true } },
    );

    expect(screen.getByText("Não foi possível pedir uma nova busca. Tente de novo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buscar novamente" })).toBeEnabled();
  });

  it("puts the counter outside the one status region, with no alert", () => {
    renderRegion({ kind: "researching", timing: timing(41, { queuePosition: 2 }) });

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.contains(screen.getByRole("timer"))).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
