/**
 * Test design (testing-strategy) — "Pesquisando lubrificante…" on the rail (background-oil-research
 * task 5.4)
 *
 * SUT: both variants' `VehicleRailRow`, imported directly (a defect in one file must not hide
 *   behind the active variant), and `VehicleDrillIn` / the Veículos list through ConversasPage with
 *   MSW, where the rail's own 3 s poll is the behaviour under test.
 *
 * Oracle: the conversas delta "A vehicle being researched says so on the rail" — the row shows
 *   research in progress; the line goes when research ends; the drill-in shows it too; both
 *   variants show the same line; the plate stays the button's name — and design.md D18: the web
 *   reads an `oilResearch` whose status it does not know as absent, so a later status can never
 *   fail the vehicle list; the drill-in looks its vehicle up by id in the polled list, not in its
 *   snapshot; the icon is static and hidden from assistive technology; not a live region.
 *
 * Cells
 *   cursor / antigravity, researching | the line, the icon aria-hidden, no live region | a variant without it
 *   either variant, researching       | the drill-in button's name still the plate       | the line inside the button
 *   either variant, absent            | no line                                          | the line for every car
 *   drill-in, poll ends research      | the line, then gone without a reload             | a snapshot read
 *   list, status "done"               | the row renders, no line                         | the list failing to parse
 */
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationSummary, Vehicle } from "@select-lub/shared-types";
import { AppProviders } from "../AppProviders.js";
import { ConversasPage } from "../ConversasPage.js";
import { useSelection } from "../selectionStore.js";
import { server } from "../../test/msw/server.js";
import { VehicleRailRow as VehicleRailRowAntigravity } from "./vehicles.rail-row.antigravity.js";
import { VehicleRailRow as VehicleRailRowCursor } from "./vehicles.rail-row.cursor.js";

const PLATE = "ABC1D23";
const LINE = "Pesquisando lubrificante…";

const vehicle: Vehicle = {
  id: "veh-a",
  customerId: "cus-1",
  omieId: null,
  plate: PLATE,
  make: "Toyota",
  model: "Corolla",
  version: "XEi",
  year: 2019,
  odometerKm: null,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const researched: Vehicle = { ...vehicle, oilResearch: { status: "researching" } };

const VARIANTS = [
  { name: "cursor", Row: VehicleRailRowCursor },
  { name: "antigravity", Row: VehicleRailRowAntigravity },
] as const;

function renderRow(Row: (typeof VARIANTS)[number]["Row"], row: Vehicle) {
  return render(
    <Row
      vehicle={row}
      pendings={[]}
      editing={false}
      busy={false}
      onOpenDrillIn={() => {}}
      onMontarOrcamento={() => {}}
      onStartEdit={() => {}}
      onSave={() => {}}
      onResolve={() => {}}
    />,
  );
}

afterEach(() => {
  useSelection.setState({ selectedConversationId: null });
  server.resetHandlers();
});

describe("the rail row's research line", () => {
  it.each(VARIANTS)("$name: shows the line with a static, hidden icon, and keeps Montar orçamento", ({ Row }) => {
    const { container } = renderRow(Row, researched);

    const line = screen.getByText(LINE);
    expect(line).toBeInTheDocument();
    const icon = line.parentElement!.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    // Not a live region: the dialog carries the announcement.
    expect(line.closest("[role=status],[aria-live]")).toBeNull();
    expect(container.querySelector("[role=status],[aria-live]")).toBeNull();
    expect(screen.getByRole("button", { name: "Montar orçamento" })).toBeEnabled();
  });

  it.each(VARIANTS)("$name: the drill-in button is still named with the plate, apart from the line", ({ Row }) => {
    renderRow(Row, researched);

    const drillIn = screen.getAllByRole("button").find((button) => (button.textContent ?? "").includes(PLATE));
    expect(drillIn).toHaveAccessibleName(expect.stringContaining(PLATE) as unknown as string);
    expect(drillIn).not.toHaveAccessibleName(expect.stringContaining(LINE) as unknown as string);
    expect(drillIn!.contains(screen.getByText(LINE))).toBe(false);
  });

  it.each(VARIANTS)("$name: shows nothing for a vehicle not being researched", ({ Row }) => {
    renderRow(Row, vehicle);

    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });
});

describe("the research line through the rail's poll", () => {
  /** Serves the vehicle list from `lists` in order, the last repeating. */
  function stubConversation(lists: object[][]) {
    let reads = 0;
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
    server.use(
      http.get("*/api/conversations", () => HttpResponse.json([conversation])),
      http.get("*/api/conversations/:id/vehicles", () => {
        const vehicles = lists[Math.min(reads, lists.length - 1)];
        reads += 1;
        return HttpResponse.json({ customerId: "cus-1", vehicles });
      }),
      http.get("*/api/vehicles/:id/services", () => HttpResponse.json([])),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <MemoryRouter>
        <AppProviders queryClient={queryClient}>
          <ConversasPage />
        </AppProviders>
      </MemoryRouter>,
    );
  }

  it("drops the drill-in's line after a poll where the vehicle is no longer researching", { timeout: 20_000 }, async () => {
    stubConversation([[researched], [researched], [vehicle]]);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));
    await user.click(await screen.findByRole("button", { name: new RegExp(PLATE) }));

    const drillIn = await screen.findByRole("region", { name: "Veículo" });
    expect(within(drillIn).getByText(LINE)).toBeInTheDocument();

    await waitFor(() => expect(within(drillIn).queryByText(LINE)).not.toBeInTheDocument(), { timeout: 8_000 });
  });

  it("renders the list without the line for a research status this bundle does not know", async () => {
    stubConversation([[{ ...vehicle, oilResearch: { status: "done" } }]]);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Roberto"));

    expect(await screen.findByRole("button", { name: new RegExp(PLATE) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Montar orçamento" })).toBeInTheDocument();
    expect(screen.queryByText(LINE)).not.toBeInTheDocument();
  });
});
