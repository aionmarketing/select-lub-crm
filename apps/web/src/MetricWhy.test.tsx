/**
 * Test design (testing-strategy)
 *
 * SUT: `useMetricWhy` and the `METRIC_EXPLANATIONS` table it reads. Exercised
 * through two harnesses that place the returned parts the way the two real
 * callers do — a card (`mark` in the head row, `body` under the value) and a
 * section (`mark` on the heading, `content` drawn by the caller while `open`).
 * The hook returns its halves separately, so no single harness can stand in for
 * both without printing the explanation twice.
 *
 * Oracle: openspec/specs/reports/relatorios/spec.md, requirement "Relatórios screen
 * shows filters summary and buckets" — scenarios "The corner mark explains the
 * metric", "A metric without an explanation has no mark" and "No REP identifier
 * appears anywhere", the last of which explicitly includes revealed text.
 * RelatoriosPage.test.tsx can only scan the page at rest, so the revealed half
 * of that scenario is checked here, over the table itself.
 *
 * Axes
 *   A1 label — in the table / absent from it
 *   A2 detail — supplied / omitted
 *   A3 disclosure state — closed / opened / closed again
 *
 * Decision map (MetricWhy.tsx)
 *   E1 `!text` T: the unexplained-label it; F: every other it
 *   E2 `detail ?` T: the detail it; F: the prose-only (section) it
 *   E3 `open ?` (mark ink, Collapse `in`) T and F: the toggle it walks both
 *
 * One-sided decisions (repo-foundation:114): NONE. E1, E2 and E3 are the only
 * decisions in the SUT and each takes both outcomes here, so the module reports
 * 100% branch and this record has no omitted outcome to justify.
 *
 * Out of scope: the mark's own colour tokens (theme.test.ts owns the palette);
 * which page labels carry a mark (RelatoriosPage.test.tsx owns that direction).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppProviders } from "./AppProviders.js";
import { METRIC_EXPLANATIONS, useMetricWhy } from "./MetricWhy.js";

/** A KPI card's shape: the mark beside the label, the collapse under the value. */
function CardHarness({ label, detail }: { label: string; detail?: ReactNode }) {
  const why = useMetricWhy(label, detail);
  return (
    <div>
      <span>{label}</span>
      {why.mark}
      {why.body}
    </div>
  );
}

/** A section heading's shape: the mark on the heading, the card the caller draws itself. */
function SectionHarness({ label }: { label: string }) {
  const why = useMetricWhy(label);
  return (
    <div>
      <span>{label}</span>
      {why.mark}
      {why.open ? <div data-testid="section-card">{why.content}</div> : null}
    </div>
  );
}

function renderHarness(ui: ReactNode) {
  return render(<AppProviders>{ui}</AppProviders>);
}

describe("useMetricWhy", () => {
  it("gives an unexplained label no mark and no empty affordance to click", async () => {
    // Guards the fixture itself: the case is only meaningful while this label
    // really is absent from the table, so a future entry for it fails here
    // rather than turning the assertion below into a tautology.
    expect(METRIC_EXPLANATIONS["Métrica sem verbete"]).toBeUndefined();

    renderHarness(<CardHarness label="Métrica sem verbete" detail={<p>detalhe</p>} />);

    expect(await screen.findByText("Métrica sem verbete")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^O que é / })).toBeNull();
    // The detail travels with the explanation: with nothing to explain, a
    // caller's detail node must not be drawn on its own either.
    expect(screen.queryByText("detalhe")).toBeNull();
  });

  it("reveals the explanation on the first activation and hides it on the second", async () => {
    const user = userEvent.setup();
    renderHarness(<CardHarness label="Total de Leads" />);

    const mark = await screen.findByRole("button", { name: "O que é Total de Leads" });
    expect(mark).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(METRIC_EXPLANATIONS["Total de Leads"]!)).toBeNull();

    await user.click(mark);

    expect(await screen.findByText(METRIC_EXPLANATIONS["Total de Leads"]!)).toBeInTheDocument();
    expect(mark).toHaveAttribute("aria-expanded", "true");

    await user.click(mark);

    // `aria-expanded` is the promise the button makes to a screen reader, and
    // the unmount is what the sighted reader gets; a mark that flipped the
    // attribute back while leaving the text on screen would satisfy neither.
    expect(mark).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      expect(screen.queryByText(METRIC_EXPLANATIONS["Total de Leads"]!)).toBeNull();
    });
  });

  it("draws the caller's detail under the explanation once the mark is open", async () => {
    const user = userEvent.setup();
    renderHarness(
      <CardHarness label="Total de Leads" detail={<p>Tabela por período</p>} />,
    );

    await user.click(await screen.findByRole("button", { name: "O que é Total de Leads" }));

    const prose = await screen.findByText(METRIC_EXPLANATIONS["Total de Leads"]!);
    const detail = screen.getByText("Tabela por período");
    // Order is the contract: the detail is what the explanation leads into, so
    // a detail drawn above the prose would read as the metric's definition.
    expect(prose.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives a section only its prose when the caller supplies no detail", async () => {
    const user = userEvent.setup();
    renderHarness(<SectionHarness label="Funil de Vendas" />);

    // A section draws nothing until asked: `open` is what the caller keys its
    // own card on, so a hook that reported true at rest would open the card.
    expect(screen.queryByTestId("section-card")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "O que é Funil de Vendas" }));

    const card = await screen.findByTestId("section-card");
    // Exactly the prose and nothing else: the hairline block exists only to
    // separate a detail from the explanation, so with no detail the card must
    // hold the one paragraph rather than an empty separated block after it.
    expect(card.textContent).toBe(METRIC_EXPLANATIONS["Funil de Vendas"]);
  });

  it("keeps every requirement identifier out of the explanations themselves", () => {
    // The page's own scan runs at rest, with every mark closed, so it cannot
    // see this text at all. The spec's scenario says "in any state, including
    // inside a revealed explanation", which is what the table is scanned for.
    for (const [label, text] of Object.entries(METRIC_EXPLANATIONS)) {
      expect(label, `${label} (key)`).not.toMatch(/REP[-\s]?\d/i);
      expect(text, `${label} (text)`).not.toMatch(/REP[-\s]?\d/i);
    }
  });
});
