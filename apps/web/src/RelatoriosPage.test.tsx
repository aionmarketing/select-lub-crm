/**
 * Test design (testing-strategy)
 *
 * Setup: RelatoriosPage in AppProviders; shared MSW. Query retry: false.
 *
 * Oracle: the relatorios delta of align-shipped-ui-to-pdf-artboards (PDF export
 * of the approved artboard, 2026-09-05) — "Relatórios screen shows filters
 * summary and buckets" (exact card set; what sits behind each mark; no
 * footnote), "Primary KPI row with deltas" (Cobertura NN% line, never n/m),
 * "Secondary KPI row" (four cards under Atendimento e clientes with their
 * captions; lapsed customers as a count with its base), "Funil de Vendas
 * stages" (`ver as N`, retention row with the weakest step in error, the drop
 * sentence), "Tabela de Origem" (`ver as N →` cell, no letter badge), and the
 * REMOVED on-screen attribution section. Empty cut when novas=0 AND ativas=0
 * AND scheduled rows=0 AND no attribution rows (relatorios/spec.md:59). Theme hexes
 * stay in theme.test.ts; the page shell in PageShell.test.tsx.
 *
 * Axes
 *   A1 query HTTP — 200 with novas / 200 empty / 200 ativas-only /
 *      200 scheduled-only / 500 / in-flight
 *   A2 granularity — day / week / month (bucket table behind the Leads mark)
 *   A3 origin — Todas / Anúncio
 *   A4 tag catalog — empty / active+inactive
 *   A5 campaign ids seen — none / from byCampaign
 *   A6 breakdown payloads — empty arrays / populated
 *   A7 section grouping — the five subject bands' accessible names
 *   A8 duplicated figure — first-response mean; Orçamentos sem resposta;
 *      the legacy Sem resposta card
 *   A9 marks — closed (detail off screen) / open (detail on screen), per mark
 *   A10 coverage — total 0 / answered 0 of 1 / 2 of 2 / 3 of 8
 *   A11 funnel — 100/80/30/12 / 2/2/0/0 (zero preceding stage)
 *   A12 customer counts — present (2 of 10, 4 served) / null
 *
 * Outputs
 *   O1 empty-copy, no metric cards
 *   O2 error + Tentar de novo
 *   O3 aria-busy skeleton
 *   O4 bucket table row count (behind the mark)
 *   O5 humanized durations
 *   O6 cards present or absent; captions
 *   O7 tag/campaign selects disabled vs sending query params
 *   O8 region names, and no name that states a time basis
 *   O9 a figure's render count across the whole screen
 *   O10 Cobertura line text, or its absence; no `(n/m)` anywhere
 *   O11 retention row text and the weakest step's colour; the drop sentence;
 *      the per-stage chevron FILL, with each stage count at full strength
 *   O12 `ver as N` / `ver as N →` text and the drill-through query string
 *
 * Sampled-cell
 *   empty cut                 | A1 empty      | O1  | cards shown
 *   HTTP 500                  | A1 500        | O2  | empty copy
 *   retry then empty          | A1 500→200    | O1  | stays on error
 *   loading gate              | A1 hang       | O3  | cards before release
 *   day then week             | A2 A9 open    | O4 3 then 2 rows | still 3
 *   month option              | A2            | O4  | request not month
 *   Anúncio empty             | A3            | O1  | AD treated as todas
 *   duration formats          | A9 open       | O5  | raw ms shown
 *   unanswered novas          | A10 0 of 1    | O5 O10 | em dash lost, Cobertura 0% missing
 *   exact card set            | A1 novas      | O6  | a removed card drawn
 *   Atendimento order         | A12 present   | O6  | order or caption wrong
 *   ativas-only not empty     | A1 ativas A10 0 | O6 O10 | empty copy, or a Cobertura line
 *   scheduled-only not empty  | A1 scheduled  | O6  | empty copy
 *   tag/campaign disabled     | A4 empty A5 none | O7 | enabled
 *   tag filter sends tagId    | A4 active     | O7  | param omitted
 *   campaign filter sends     | A5 seen       | O7  | param omitted
 *   breakdown cards + marks   | A6 populated A9 | O6 | tag table missing, campaign rows on screen closed
 *   campaign-only row         | A6            | O6  | ids invented
 *   attribution off screen    | A1 novas      | O6 O9 | Associação region or "1 de 2" drawn
 *   window behind Conversão   | A9 open       | O6  | window sentence missing
 *   five subject sections     | A7            | O8  | a band named by its clock
 *   mean printed once         | A8 A9 open    | O9 O10 | mean in card AND detail; a fraction
 *   quote pendency in strip   | A8            | O9  | a second Orçamentos card
 *   period vs moment label    | A8            | O8 O9 | two near-synonyms, or a lost mark
 *   tags: both empty          | A6 empty      | O6  | a lone card, or zeros
 *   tags: one side only       | A6 tags only  | O6  | one card, or the absence line missing
 *   retention row + sentence  | A11 100/80/30/12 | O11 | 37,5% not red, sentence wrong
 *   zero preceding stage      | A11 2/2/0/0   | O11 | Serviços Feitos shows seguem
 *   stage drill-through       | A11           | O12 | stage/from/to missing
 *   origin drill-through      |               | O12 | origin/from/to missing; ver as N → absent
 *   origin keyboard           |               | O12 | Enter does nothing
 *   coverage 38%              | A10 3 of 8    | O10 | (3/8) drawn
 *   REP absent                |               | —   | REP-nn in body text
 *   mark explains             | A9            | O6  | copy visible while closed
 *   no mark unexplained       |               | O6  | empty affordance
 *   strip unavailable/partial |               | O6  | zeros drawn
 *   filter bar clear control  |               | O7  | count wrong
 *   delta chips               |               | O6  | colour wrong / 0% red
 *
 * Decision map (RelatoriosPage.tsx)
 *   D1 formatDuration ms===null T: unansweredResult dashes; F: dayResult
 *   D2 hours > 0 T: p90 3600000; F: mean 1000 and median 61000
 *   D3 minutes > 0 (after D2 F) T: median 61000; F: mean 1000
 *   D4 toPeriodInstant: isYmd T: default pickers; F: cleared Início (unbounded sentinels).
 *      endOfDayExclusive T: Fim; F: Início — both on every render
 *   D5 origin === "ALL" T: default fetch; F: Anúncio
 *   D6 isLoading T: gate; F: other tests
 *   D7 isError T: 500; F: 200 tests
 *   D8 isEmptyCut T: emptyResult; F: day / ativas-only / scheduled-only / atribuição-only
 *   D9 coverage.total === 0 T: ativas-only (no line); F: dayResult (Cobertura 100%)
 *   D10 scheduledHasRows T: scheduled-only; F: emptyResult / dayResult
 *   D11 activeTags.length===0 T: default tags MSW []; F: tag filter it
 *      (assert aria-disabled: MUI Select combobox is a div)
 *   D12 campaignFilterDisabled T: dayResult; F: remainder with byCampaign
 *   D13 tagId === "ALL" T: default; F: tag filter sends tagId
 *   D14 campaignId === "ALL" T: default; F: campaign filter sends id
 *   D15 byTag.length===0 && !hasScheduled T: dayResult sentence; F: tag-only / scheduled-only cards
 *   D16 CountCard rows.length===0 T: scheduled card on tag-only fixture; F: populated
 *   D17 meanWaitMs items.length===0 T: dayResult no caption; F: items it
 *   D18 tag.active filter T: Retorno in menu; F: inactive omitted
 *   D19 origin conversionRate==null T: dayResult ("—"); F: rates it
 *   D20 lapsedCustomers/customersWithService null T: null-counts it ("—" plus its own reason caption); F: dayResult 2 / 20% dos 10
 *   D21 customersServedInPeriod null T: same it, with a caption that DIFFERS from D20's; F: dayResult "entre os 4"
 *   D22 approvalRate == null T: dayResult caption; F: approval 0.5 it
 *   D23 followUp.isSuccess T: default empty strip / chip its; F: follow-up 500 it
 *   D24 leads.value ?? 0 T: null leads it; F: dayResult "2"
 *   D25 adSetId/adId ?? "" T: campaign-only row; F: remainderPopulated
 *   D26 improved: null (delta 0 / absent) → default grey chip; T (+100 / −15
 *      lowerIsBetter) success-container fill; F (−20) error-container fill
 *   D27 why.open (section marks) T: opened funnel/origin marks; F: closed by default
 *   D28 retention previous > 0 T: 100/80/30/12; F: 2/2/0/0 last stage
 *   D29 weakestIndex > 0 T: drop sentence its; F: novos 0 → no sentence (contract: novos 0 with
 *      other stages 0 is the empty cut, so the F arm is reached only by the ativas-only fixture)
 *   D30 campaigns.length===0 T: dayResult origin mark; F: remainderPopulated origin mark
 *   D31 !data after !loading !error — contract-hidden (TanStack success has data)
 *   D32 leads/total >= 10% share floor T: 50/50 rows both eligible; F: the 1-of-26
 *      shipped-capture row excluded despite converting 100%
 *   D33 tie on top rate → volume tie-break T: 60 vs 30 leads at 0.5 → the 60 tinted;
 *      F (tie on rate AND volume, 40 vs 40) → nothing tinted
 *   D34 conversionRate > 0 eligibility T: a converting row; F: all-zero table tints nothing
 *
 * One-sided decisions, added 2026-09-07 — the record repo-foundation:114
 * requires before a reachable decision may keep a single outcome. The map above
 * is unchanged; these are the four arms this suite does NOT take, each with the
 * class that permits it. Everything else in the SUT now takes both outcomes.
 *
 *   S1 attributionHasRows `conversion.total > 0` — CONTRACT-INFEASIBLE at this
 *      call site. It counts customer-linked novas, and `isEmptyCut` only
 *      evaluates the guard once novas is already zero, so the T arm cannot be
 *      reached however the fixture is built.
 *   S2 lapsedCaption's third arm (line 456) — CONTRACT-INFEASIBLE. Needs
 *      `lapsedCustomers` non-null while `customersWithService` is falsy. The
 *      shared Relatórios contract makes the three customer counts "each null
 *      when the period holds no customer with a service", and the producer
 *      enforces it structurally: `churnAndLtv` builds `inPeriod` by filtering
 *      `byCustomer`'s own entries, so a non-empty `inPeriod` implies a
 *      non-empty `byCustomer` (verified in the API suite by Session 6).
 *   S3 isEmptyCut's fourth conjunct `!attributionHasRows` — settled: the spec
 *      at relatorios/spec.md:59 names attribution rows, and a serviced-return
 *      scenario at :73-75 requires the report, not the empty state. Sampled
 *      below as "atribuição only".
 *   S4 FollowUpAlertStrip empty chips on a successful 200 — settled: the strip
 *      SHALL render. Unavailable copy stays on the 500 path; a 200 that omits
 *      the three chip keys still draws the band. In-flight still returns null
 *      so chip tests wait for the region the way they did before.
 *
 * Out of scope: Playwright; widths (visual-qa artifacts); live API; the mark
 * component itself beyond its use here; canvas republish (Claude).
 */

import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { METRIC_EXPLANATIONS } from "./MetricWhy.js";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyReportInsights,
  type ConversationPipelineStage,
  type ReportResult,
  type Tag,
} from "@select-lub/shared-types";
import { AppProviders } from "./AppProviders.js";
// Funnel captions: FUNNEL_STAGE_LABELS (title case). Thread captions are
// THREAD_STAGE_LABELS.
import { FUNNEL_STAGE_LABELS } from "./conversas/inboxLink.js";
import { RelatoriosPage } from "./RelatoriosPage.js";
import { contrastRatio } from "./theme.js";
import { PALETTE_STORAGE_KEY, usePalette } from "./paletteStore.js";
import { server } from "../test/msw/server.js";

// The delta chip is painted from the theme's status containers (#e6f4ea /
// #ffe0e0), so the assertion reads the computed fill rather than MUI's
// colorSuccess / colorError class, which the chip no longer carries.
const SUCCESS_CONTAINER = "rgb(230, 244, 234)";
const ERROR_CONTAINER = "rgb(255, 224, 224)";

const EMPTY_CUT_COPY =
  "Nenhuma conversa no recorte selecionado. Ajuste o período ou os filtros.";

const REMOVED_CARDS = [
  "Conversas novas",
  "Conversas ativas",
  "Taxa de respondidas",
  "Tempo de primeira resposta",
  "Tempo de resposta subsequente",
  "Associação no tempo",
  "Conversas por campanha/anúncio",
  "Período",
];

const remainder = {
  unanswered: { count: 0, items: [] as { conversationId: string; waitMs: number }[] },
  subsequentResponse: {
    meanMs: null as number | null,
    medianMs: null as number | null,
    p90Ms: null as number | null,
    eligibleCount: 0,
    inboundTotal: 0,
  },
  respondedRate: { answered: 0, total: 0 },
  byTag: [] as ReportResult["byTag"],
  byCampaign: [] as ReportResult["byCampaign"],
  scheduled: { scheduled: 0, sent: 0, cancelled: 0, failed: 0 },
  attribution: {
    rule: { windowDays: 30, version: 1 },
    scheduledReturn: { count: 0 },
    conversion: { converted: 0, total: 0, bySource: [] as ReportResult["attribution"]["conversion"]["bySource"] },
  },
  insights: emptyReportInsights(),
};

const tagRetorno: Tag = {
  id: "tag-1",
  name: "Retorno",
  color: "primary",
  sortOrder: 0,
  active: true,
};

const tagInactive: Tag = {
  id: "tag-2",
  name: "Arquivada",
  color: "secondary",
  sortOrder: 1,
  active: false,
};

const dayResult: ReportResult = {
  query: {
    periodStart: "2026-08-01T03:00:00.000Z",
    periodEnd: "2026-09-01T03:00:00.000Z",
    granularity: "day",
  },
  buckets: [
    { bucketStart: "2026-08-10", newConversationCount: 1, activeConversationCount: 1 },
    { bucketStart: "2026-08-11", newConversationCount: 1, activeConversationCount: 1 },
  ],
  newConversationCount: 2,
  activeConversationCount: 2,
  firstResponse: {
    meanMs: 1000,
    medianMs: 61_000,
    p90Ms: 3_600_000,
    eligibleCount: 2,
  },
  coverage: { answered: 2, total: 2 },
  ...remainder,
  subsequentResponse: {
    meanMs: 2000,
    medianMs: 120_000,
    p90Ms: 7_200_000,
    eligibleCount: 2,
    inboundTotal: 2,
  },
  respondedRate: { answered: 2, total: 2 },
  insights: {
    primary: {
      leads: { value: 2, deltaPct: 100 },
      conversionRate: { value: null },
      revenue: { value: 0 },
      meanFirstResponseMs: { value: 1000, deltaPct: -15 },
    },
    secondary: {
      unanswered: 0,
      unansweredQuotes: 0,
      approvalRate: null,
      churnRate: 0.2,
      ltv: 450,
      lapsedCustomers: 2,
      customersWithService: 10,
      customersServedInPeriod: 4,
    },
    funnel: { novosContatos: 2, emAtendimento: 2, orcamentoEnviado: 0, servicosFeitos: 0 },
    originRows: emptyReportInsights().originRows,
  },
};

const weekResult: ReportResult = {
  ...dayResult,
  query: { ...dayResult.query, granularity: "week" },
  buckets: [{ bucketStart: "2026-08-10", newConversationCount: 2, activeConversationCount: 2 }],
};

const unansweredResult: ReportResult = {
  ...dayResult,
  buckets: [{ bucketStart: "2026-08-10", newConversationCount: 1, activeConversationCount: 1 }],
  newConversationCount: 1,
  activeConversationCount: 1,
  firstResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
  },
  coverage: { answered: 0, total: 1 },
  insights: {
    ...dayResult.insights,
    primary: { ...dayResult.insights.primary, meanFirstResponseMs: { value: null } },
  },
  unanswered: {
    count: 1,
    items: [{ conversationId: "conv-wait", waitMs: 5000 }],
  },
  subsequentResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
    inboundTotal: 1,
  },
  respondedRate: { answered: 0, total: 1 },
};

const emptyResult: ReportResult = {
  query: dayResult.query,
  buckets: [],
  newConversationCount: 0,
  activeConversationCount: 0,
  firstResponse: {
    meanMs: null,
    medianMs: null,
    p90Ms: null,
    eligibleCount: 0,
  },
  coverage: { answered: 0, total: 0 },
  ...remainder,
};

const ativasOnlyResult: ReportResult = {
  ...emptyResult,
  activeConversationCount: 1,
  buckets: [{ bucketStart: "2026-08-10", newConversationCount: 0, activeConversationCount: 1 }],
};

/** Novas alone, the one non-empty input the suite never sampled on its own. */
const novasOnlyResult: ReportResult = {
  ...emptyResult,
  newConversationCount: 1,
  buckets: [{ bucketStart: "2026-08-10", newConversationCount: 1, activeConversationCount: 0 }],
  insights: {
    ...emptyReportInsights(),
    primary: { ...emptyReportInsights().primary, leads: { value: 1 } },
  },
};

const scheduledOnlyResult: ReportResult = {
  ...emptyResult,
  scheduled: { scheduled: 0, sent: 1, cancelled: 0, failed: 0 },
};

const attributionOnlyResult: ReportResult = {
  ...emptyResult,
  attribution: {
    ...emptyResult.attribution,
    scheduledReturn: { count: 2 },
  },
};

const remainderPopulated: ReportResult = {
  ...dayResult,
  unanswered: {
    count: 2,
    items: [
      { conversationId: "c1", waitMs: 1000 },
      { conversationId: "c2", waitMs: 3000 },
    ],
  },
  byTag: [{ tagId: "tag-1", name: "Retorno", count: 2 }],
  byCampaign: [{ campaignId: "camp-1", adSetId: "set-1", adId: "ad-1", count: 1 }],
  scheduled: { scheduled: 3, sent: 4, cancelled: 1, failed: 2 },
};

const funnelResult: ReportResult = {
  ...dayResult,
  insights: {
    ...dayResult.insights,
    funnel: { novosContatos: 100, emAtendimento: 80, orcamentoEnviado: 30, servicosFeitos: 12 },
  },
};

afterEach(() => {
  server.resetHandlers();
  usePalette.setState({ paletteId: "yellow-cta" });
  localStorage.removeItem(PALETTE_STORAGE_KEY);
});

/**
 * Stands in for the Conversas inbox on funnel/origin navigation tests: prints
 * the exact query string that arrived, so a test can assert the built link
 * carries what the requirement names — stage, origin, period — without
 * mounting the real inbox.
 */
function InboxRouteEcho() {
  const [params] = useSearchParams();
  return <p data-testid="inbox-route">{params.toString()}</p>;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <MemoryRouter initialEntries={["/relatorios"]}>
      <AppProviders queryClient={queryClient}>
        <Routes>
          <Route path="/relatorios" element={<RelatoriosPage />} />
          <Route path="/follow-up" element={<p>Follow-up screen</p>} />
          <Route path="/" element={<InboxRouteEcho />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
}

function serveReport(result: ReportResult) {
  server.use(http.get("*/api/reports/conversations", () => HttpResponse.json(result)));
}

/**
 * The value rendered on the card that carries `label`.
 *
 * Found by the card's tagged value rather than by DOM adjacency: the label
 * shares a row with its explanation mark, so "the element after the label" is
 * the mark, not the number.
 */
function metricValue(label: HTMLElement) {
  const card = label.closest("div")?.parentElement;
  return card?.querySelector('[data-testid="metric-value"]')?.textContent ?? null;
}

/** The card holding `label`, for asserting its caption. */
function cardOf(label: HTMLElement) {
  return label.closest("div")!.parentElement as HTMLElement;
}

async function openMark(label: string) {
  await userEvent.setup().click(screen.getByRole("button", { name: `O que é ${label}` }));
}

describe("RelatoriosPage", () => {
  it("shows Portuguese empty state when the cut has no novas ativas or scheduled rows", async () => {
    serveReport(emptyResult);
    renderPage();

    expect(await screen.findByText(EMPTY_CUT_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Total de Leads")).not.toBeInTheDocument();
  });

  it("shows Portuguese error with retry", async () => {
    server.use(
      http.get("*/api/reports/conversations", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Não foi possível carregar o relatório.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("loads the empty cut after retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get("*/api/reports/conversations", () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        }
        return HttpResponse.json(emptyResult);
      }),
    );
    renderPage();
    expect(await screen.findByText("Não foi possível carregar o relatório.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

    expect(await screen.findByText(EMPTY_CUT_COPY)).toBeInTheDocument();
  });

  it("shows a loading skeleton before data arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("*/api/reports/conversations", async () => {
        await gate;
        return HttpResponse.json(dayResult);
      }),
    );
    renderPage();

    expect(await screen.findByLabelText("Início")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    release();
    expect(await screen.findByText("Total de Leads")).toBeInTheDocument();
  });

  it("keeps Relatórios mounted when Início is cleared", async () => {
    const user = userEvent.setup();
    // Default MSW serves the empty cut, which never prints Total de Leads.
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");

    await user.clear(screen.getByLabelText("Início"));

    expect(screen.getByRole("heading", { name: "Relatórios" })).toBeInTheDocument();
    expect(screen.getByLabelText("Início")).toHaveValue("");
    expect(screen.getByLabelText("Fim")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Início ou Fim está em aberto, então os deltas não comparam com um período anterior.",
      ),
    ).toBeInTheDocument();
  });

  it("reaggregates the bucket table behind the Leads mark when granularity switches to week", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("granularity") === "week") {
          return HttpResponse.json(weekResult);
        }
        return HttpResponse.json(dayResult);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");
    // The period table is not on the screen until the mark is opened.
    expect(screen.queryByRole("table", { name: "Conversas por período" })).toBeNull();
    await openMark("Total de Leads");
    const table = await screen.findByRole("table", { name: "Conversas por período" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Dia")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Granularidade"));
    await user.click(await screen.findByRole("option", { name: "Semana" }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("table", { name: "Conversas por período" })).getAllByRole("row"),
      ).toHaveLength(2);
    });
    expect(within(screen.getByRole("table", { name: "Conversas por período" })).getByText("Semana")).toBeInTheDocument();
  });

  it("requests month granularity from the Mês option", async () => {
    const user = userEvent.setup();
    const granularities: string[] = [];
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        granularities.push(new URL(request.url).searchParams.get("granularity") ?? "");
        return HttpResponse.json({
          ...dayResult,
          query: { ...dayResult.query, granularity: "month" },
          buckets: [{ bucketStart: "2026-08-01", newConversationCount: 2, activeConversationCount: 2 }],
        } satisfies ReportResult);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");

    await user.click(screen.getByLabelText("Granularidade"));
    await user.click(await screen.findByRole("option", { name: "Mês" }));

    await waitFor(() => {
      expect(granularities).toContain("month");
    });
  });

  it("shows the empty state when Origem Anúncio has no AD novas", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        if (new URL(request.url).searchParams.get("sourceType") === "AD") {
          return HttpResponse.json(emptyResult);
        }
        return HttpResponse.json(dayResult);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");

    await user.click(screen.getByLabelText("Origem"));
    await user.click(await screen.findByRole("option", { name: "Anúncio" }));

    expect(await screen.findByText(EMPTY_CUT_COPY)).toBeInTheDocument();
    expect(screen.queryByText("Total de Leads")).not.toBeInTheDocument();
  });

  it("humanizes the median and p90 lines behind the Tempo Médio mark", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Tempo Médio de Resposta");
    expect(screen.queryByText("mediana")).toBeNull();

    await openMark("Tempo Médio de Resposta");

    const first = (await screen.findByText("Primeira resposta")).parentElement as HTMLElement;
    expect(within(first).getByText("1m 1s")).toBeInTheDocument();
    expect(within(first).getByText("1h 0m")).toBeInTheDocument();
    expect(within(first).queryByText("média")).toBeNull();
    const along = screen.getByText("Ao longo da conversa").parentElement as HTMLElement;
    expect(within(along).getByText("2s")).toBeInTheDocument();
    expect(within(along).getByText("2m 0s")).toBeInTheDocument();
    expect(within(along).getByText("2h 0m")).toBeInTheDocument();
    expect(within(along).getByText("média")).toBeInTheDocument();
  });

  it("shows em dashes and Cobertura 0% when novas exist but none were answered", async () => {
    serveReport(unansweredResult);
    renderPage();

    const label = await screen.findByText("Tempo Médio de Resposta");
    expect(metricValue(label)).toBe("—");
    expect(
      within(cardOf(label)).getByText(
        "Cobertura 0% — conversas sem evento de saída observado ficam de fora.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Taxa de respondidas")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("draws exactly the artboard's cards and none of the retired ones", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");

    for (const label of [
      "Taxa de Conversão",
      "Receita Gerada",
      "Tempo Médio de Resposta",
      "Conversas sem resposta no período",
      "Taxa de Aprovação",
      "Clientes perdidos no período",
      "Receita média por cliente",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const removed of REMOVED_CARDS) {
      expect(screen.queryByText(removed)).toBeNull();
    }
    expect(screen.queryByText("Churn")).toBeNull();
    expect(screen.queryByText("LTV")).toBeNull();
    // The Detalhe footnote the artboard carries is reviewer commentary, not product copy.
    expect(screen.queryByText(/Não existe mais uma seção/)).toBeNull();
    // No letter badges on the origin rows or the cards.
    const origin = screen.getByRole("table", { name: "Tabela de Origem" });
    expect(within(origin).queryByText(/^[AOD]$/)).toBeNull();
  });

  it("orders the four Atendimento cards and prints their captions from the counts", async () => {
    serveReport(dayResult);
    renderPage();

    const band = await screen.findByRole("region", { name: "Atendimento e clientes" });
    const labels = within(band)
      .getAllByText(/^(Conversas sem resposta no período|Taxa de Aprovação|Clientes perdidos no período|Receita média por cliente)$/)
      .map((element) => element.textContent);
    expect(labels).toEqual([
      "Conversas sem resposta no período",
      "Taxa de Aprovação",
      "Clientes perdidos no período",
      "Receita média por cliente",
    ]);
    expect(screen.queryByRole("region", { name: "Indicadores principais" })).not.toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Indicadores principais" })).queryByText("Taxa de Aprovação"),
    ).toBeNull();

    const lapsed = within(band).getByText("Clientes perdidos no período");
    expect(metricValue(lapsed)).toBe("2");
    expect(within(cardOf(lapsed)).getByText("20% dos 10 clientes com serviço")).toBeInTheDocument();
    const average = within(band).getByText("Receita média por cliente");
    expect(within(cardOf(average)).getByText("entre os 4 clientes com serviço")).toBeInTheDocument();
    const approval = within(band).getByText("Taxa de Aprovação");
    expect(metricValue(approval)).toBe("—");
    expect(within(cardOf(approval)).getByText("nenhum orçamento enviado no recorte")).toBeInTheDocument();
    // No wait caption without unanswered items.
    expect(screen.queryByText(/espera média/)).toBeNull();
  });

  it("explains every absent card in both banded rows rather than printing a bare dash", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        // Every card that CAN be absent is absent at once, so the sweep below
        // sees all of them in one render rather than one per fixture.
        // `conversionRate` is already null on dayResult; `meanFirstResponseMs`
        // is nulled here for a cut whose novas got no first reply.
        primary: {
          ...dayResult.insights.primary,
          meanFirstResponseMs: { value: null },
        },
        secondary: {
          ...dayResult.insights.secondary,
          churnRate: null,
          ltv: null,
          lapsedCustomers: null,
          customersWithService: null,
          customersServedInPeriod: null,
        },
      },
    });
    renderPage();

    const lapsed = await screen.findByText("Clientes perdidos no período");
    expect(metricValue(lapsed)).toBe("—");
    const average = screen.getByText("Receita média por cliente");
    expect(metricValue(average)).toBe("—");

    // Each absent card names ITS OWN base: Clientes perdidos has nobody who
    // could fall due, Receita média has nothing to divide by. Asserting that
    // the two captions DIFFER is the point — one sentence shared across the
    // band would satisfy "has a caption" while telling the reader less than
    // the line Taxa de Aprovação already carries.
    const lapsedNote = within(cardOf(lapsed)).getByText("nenhum cliente com serviço no recorte");
    const averageNote = within(cardOf(average)).getByText("nenhum cliente atendido no recorte");
    expect(lapsedNote.textContent).not.toBe(averageNote.textContent);

    // The populated case's base captions must not survive into the absent one.
    expect(screen.queryByText(/dos \d+ clientes com serviço/)).toBeNull();
    expect(screen.queryByText(/entre os \d+ clientes com serviço/)).toBeNull();

    // Band-wide guard, not card-by-card, and now across BOTH banded rows.
    // Indicadores principais was outside the first sweep and a fourth bare
    // dash duly surfaced there — Taxa de Conversão — which is the argument
    // for sweeping rather than naming cards: a card-by-card assertion passes
    // forever while the identical bug walks in on a card it does not name.
    const bands = {
      "Indicadores principais": [
        "Total de Leads",
        "Taxa de Conversão",
        "Receita Gerada",
        "Tempo Médio de Resposta",
      ],
      "Atendimento e clientes": [
        "Conversas sem resposta no período",
        "Taxa de Aprovação",
        "Clientes perdidos no período",
        "Receita média por cliente",
      ],
    };
    const captions: string[] = [];
    for (const [bandName, labels] of Object.entries(bands)) {
      const band = screen.getByRole("region", { name: bandName });
      for (const label of labels) {
        const heading = within(band).getByText(label);
        if (metricValue(heading) !== "—") {
          continue;
        }
        const note = cardOf(heading).querySelector('[data-testid="metric-note"]');
        expect(note?.textContent ?? "", `${bandName} → ${label}`).not.toBe("");
        captions.push(note!.textContent!);
      }
    }

    // CONTRACT-INFEASIBLE, and so deliberately unsampled: `lapsedCaption`'s
    // third arm, where `lapsedCustomers` is present but `customersWithService`
    // is not, and the card falls back to no caption at all. Reaching it needs a
    // payload the contract forbids — the shared Relatórios contract makes the
    // three customer counts "each null when the period holds no customer with a
    // service", and "Lapsed customers and average revenue follow the period"
    // adds that an empty period yields absent values for the counts alike. So a
    // non-null lapsed count travels with a non-null base, and the two arms
    // sampled here are the only two the contract can produce.
    //
    // Exactly the cards that can be absent, so a card losing or gaining that
    // ability is a visible change here rather than a silent one.
    expect(captions).toHaveLength(5);
    // Every reason names its own base, so no two are the same sentence. This
    // is what "specific to that figure" means operationally; "has a caption"
    // alone is satisfied by one line shared across all four.
    expect(new Set(captions).size).toBe(5);
  });

  it("prints Taxa de Aprovação as a percentage with no caption when quotes were sent", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        secondary: { ...dayResult.insights.secondary, approvalRate: 0.5 },
      },
    });
    renderPage();

    const approval = await screen.findByText("Taxa de Aprovação");
    expect(metricValue(approval)).toBe("50%");
    expect(screen.queryByText("nenhum orçamento enviado no recorte")).toBeNull();
  });

  it("prints Taxa de Conversão as a percentage with no caption when novas were linked", async () => {
    // The symmetric half of the case above, and the one the suite was missing:
    // every fixture carried `conversionRate: { value: null }`, so the card had
    // only ever been seen ABSENT. Its reason line was therefore asserted
    // present but never asserted to go away, and a caption pinned on
    // unconditionally would have satisfied both the absent-card sweep and the
    // exact-card-set case. The requirement states the reason for the absent
    // side only — "Taxa de Conversão is absent when no conversation in the cut
    // is linked to a customer" — so a cut that HAS linked novas carries a rate
    // and nothing to explain.
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        primary: { ...dayResult.insights.primary, conversionRate: { value: 0.4 } },
      },
    } satisfies ReportResult);
    renderPage();

    const conversion = await screen.findByText("Taxa de Conversão");
    expect(metricValue(conversion)).toBe("40%");
    expect(cardOf(conversion).querySelector('[data-testid="metric-note"]')).toBeNull();
    expect(screen.queryByText("nenhuma conversa vinculada a cliente no recorte")).toBeNull();
  });

  it("places the alert strip above KPIs and the funnel above the origin table", async () => {
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ unansweredQuotes: 5, overdueReturns: 3, upcomingReturns: 0, waitingReply: 8 }),
      ),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();
    await screen.findByText("Total de Leads");

    const alert = screen.getByRole("region", { name: "Alertas de follow-up" });
    const funnel = screen.getByRole("region", { name: "Funil de Vendas" });
    const origin = screen.getByRole("region", { name: "Tabela de Origem" });
    expect(alert.compareDocumentPosition(funnel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(funnel.compareDocumentPosition(origin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(alert).getByText("deste momento · não muda com os filtros abaixo")).toBeInTheDocument();
    expect(screen.queryByText("expirando hoje")).not.toBeInTheDocument();
    expect(screen.queryByText("sem responsável")).not.toBeInTheDocument();
  });

  it("fades the funnel fill per stage and keeps every stage count at full strength", async () => {
    serveReport(dayResult);
    renderPage();
    const funnel = await screen.findByRole("region", { name: "Funil de Vendas" });

    // The chevron is the link's first child; the fade is a step of 0.12 on the
    // FILL, so the fourth stage is alpha(primary.main, 0.64) while its opacity
    // — which would have faded the count with it — stays at 1.
    const chevron = (name: string) =>
      within(funnel).getByRole("link", { name }).firstElementChild as HTMLElement;
    const first = chevron("Conversas da etapa Novos Contatos");
    const last = chevron("Conversas da etapa Serviços Feitos");

    // Stage 1 is the brand gold untouched; stage 4 is a LIGHTER solid, not the
    // same gold at reduced opacity, so both boxes stay fully opaque and the
    // count on them is never faded.
    expect(first).toHaveStyle({ backgroundColor: "rgb(234, 182, 61)", opacity: "1" });
    expect(last).toHaveStyle({ opacity: "1" });
    const fillOf = (el: HTMLElement) => getComputedStyle(el).backgroundColor;
    expect(fillOf(last)).not.toBe(fillOf(first));
    expect(contrastRatio(fillOf(last), "#FFFFFF")).toBeLessThan(
      contrastRatio(fillOf(first), "#FFFFFF"),
    );
  });

  it.each(["yellow-cta", "black-cta"] as const)(
    "keeps every funnel stage count readable at AA on %s",
    async (id) => {
      serveReport(dayResult);
      usePalette.setState({ paletteId: id });
      renderPage();
      const funnel = await screen.findByRole("region", { name: "Funil de Vendas" });

      // By RATIO, not by fixed colours: a hex assertion would pass today and
      // say nothing the day the ramp changes. Every stage's own count on its
      // own fill has to clear 4.5, which the opacity ramp did not on black-cta.
      const stages = within(funnel).getAllByRole("link", { name: /^Conversas da etapa / });
      expect(stages).toHaveLength(4);
      for (const link of stages) {
        const chevron = link.firstElementChild as HTMLElement;
        const { color, backgroundColor, opacity } = getComputedStyle(chevron);
        // Opacity belongs in this assertion: a ratio computed from the two
        // declared colours says nothing about what reaches the screen if the
        // box is then faded, which is exactly how the old ramp passed while
        // rendering a 2.6:1 numeral.
        expect(opacity).toBe("1");
        expect(contrastRatio(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(["yellow-cta", "black-cta"] as const)(
    "outlines the alert strip's chips against their band on %s",
    async (id) => {
      server.use(
        http.get("*/api/follow-up-counts", () =>
          HttpResponse.json({
            unansweredQuotes: 5,
            overdueReturns: 3,
            upcomingReturns: 0,
            waitingReply: 8,
          }),
        ),
        http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
      );
      usePalette.setState({ paletteId: id });
      renderPage();
      const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });

      // Both palettes, because the defect was palette-dependent and all but
      // invisible from one of them: the white pill carried 1.87:1 against
      // black-cta's gold band but only 1.11:1 against yellow-cta's cream one,
      // and the yellow figure is the default palette's. By RATIO rather than
      // by hex, so this keeps meaning something if either band is retinted.
      const band = getComputedStyle(strip).backgroundColor;
      const chips = within(strip).getAllByRole("link");
      expect(chips).toHaveLength(3);
      for (const chip of chips) {
        const { borderTopColor, borderTopStyle, backgroundColor, color } = getComputedStyle(chip);
        // A chip here is a link, so 3:1 is what its BOUNDARY owes (WCAG 2.2
        // 1.4.11 non-text contrast), a different threshold from the 4.5:1 its
        // label owes. Both are asserted: an outline dark enough to be seen is
        // no use if the fix arrived by darkening the pill under the text.
        expect(borderTopStyle).not.toBe("none");
        expect(contrastRatio(borderTopColor, band)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
        // The band is not the fix and must not become one: the strip keeps the
        // primary-container fill, so the pill still sits on a tint rather than
        // on a card the artboard does not draw.
        expect(backgroundColor).not.toBe(band);
      }
    },
  );

  describe("which origin row carries the highlight", () => {
    /** A report whose origin table carries `rows`; everything else from dayResult. */
    const withOriginRows = (rows: ReportResult["insights"]["originRows"]): ReportResult => ({
      ...dayResult,
      insights: { ...dayResult.insights, originRows: rows },
    });

    /**
     * Accessible names of the origin rows painted with the tint.
     *
     * "Has a background at all" rather than a hex match: the tint is a theme
     * token whose value differs between the two palettes, and every assertion
     * here is about WHICH row is marked, never about the colour marking it.
     */
    const tinted = (table: HTMLElement) =>
      within(table)
        .getAllByRole("link", { name: /^Conversas de origem / })
        .filter((row) => {
          const fill = getComputedStyle(row).backgroundColor;
          return fill !== "" && fill !== "transparent" && fill !== "rgba(0, 0, 0, 0)";
        })
        .map((row) => row.getAttribute("aria-label"));

    const originTable = () => screen.findByRole("table", { name: "Tabela de Origem" });

    it("marks the highest rate, not the first row that converted", async () => {
      // Assistant A's fixture: TWO converting origins at different rates. With
      // only one converting row — which is all the shipped capture had — the
      // data cannot tell "highest rate" from "first row with any conversion".
      // Anúncio converts and comes first, so the weaker rule would mark it.
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 50, conversions: 5, conversionRate: 0.1, revenue: 100 },
          { origin: "ORGANIC", leads: 50, conversions: 15, conversionRate: 0.3, revenue: 300 },
          { origin: "UNKNOWN", leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
        ]),
      );
      renderPage();
      expect(tinted(await originTable())).toEqual(["Conversas de origem Orgânica"]);
    });

    it("does not mark a high rate earned on too few leads", async () => {
      // Anúncio converts every lead it has, but one lead in a hundred is not a
      // finding. The floor is a SHARE, so this holds on a slow week too.
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 1, conversions: 1, conversionRate: 1, revenue: 90 },
          { origin: "ORGANIC", leads: 50, conversions: 10, conversionRate: 0.2, revenue: 500 },
          { origin: "UNKNOWN", leads: 49, conversions: 0, conversionRate: 0, revenue: 0 },
        ]),
      );
      renderPage();
      expect(tinted(await originTable())).toEqual(["Conversas de origem Orgânica"]);
    });

    it("breaks a tie on rate by lead volume", async () => {
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 60, conversions: 30, conversionRate: 0.5, revenue: 900 },
          { origin: "ORGANIC", leads: 30, conversions: 15, conversionRate: 0.5, revenue: 450 },
          { origin: "UNKNOWN", leads: 10, conversions: 0, conversionRate: 0, revenue: 0 },
        ]),
      );
      renderPage();
      expect(tinted(await originTable())).toEqual(["Conversas de origem Anúncio"]);
    });

    it("marks nothing when rate and volume are both tied", async () => {
      // A mark on two rows singles out neither, which is the whole job of it.
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 40, conversions: 20, conversionRate: 0.5, revenue: 600 },
          { origin: "ORGANIC", leads: 40, conversions: 20, conversionRate: 0.5, revenue: 600 },
          { origin: "UNKNOWN", leads: 20, conversions: 0, conversionRate: 0, revenue: 0 },
        ]),
      );
      renderPage();
      expect(tinted(await originTable())).toEqual([]);
    });

    it("marks nothing on the shipped capture that raised this", async () => {
      // The exact numbers from relatorios-1440.png, where the tint landed on a
      // one-lead row and passed over the row holding 24 of the 26 leads.
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 1, conversions: 0, conversionRate: 0, revenue: 0 },
          { origin: "ORGANIC", leads: 1, conversions: 1, conversionRate: 1, revenue: 0 },
          { origin: "UNKNOWN", leads: 24, conversions: 0, conversionRate: 0, revenue: 0 },
        ]),
      );
      renderPage();
      expect(tinted(await originTable())).toEqual([]);
    });

    it("explains the tint in the section note and puts no cue in the row", async () => {
      serveReport(
        withOriginRows([
          { origin: "AD", leads: 50, conversions: 5, conversionRate: 0.1, revenue: 100 },
          { origin: "ORGANIC", leads: 50, conversions: 15, conversionRate: 0.3, revenue: 300 },
          { origin: "UNKNOWN", leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
        ]),
      );
      renderPage();
      const section = await screen.findByRole("region", { name: "Tabela de Origem" });

      // Both halves: a reader told only that the tint means "best converting"
      // would wonder why their 100% row is not tinted.
      expect(within(section).getByText(/maior taxa de conversão/)).toBeInTheDocument();
      expect(within(section).getByText(/menos de 10% dos leads/)).toBeInTheDocument();

      // The note is the ONLY explanation. The marked row keeps the same
      // accessible name as every other row and gains no marker of its own.
      const table = within(section).getByRole("table", { name: "Tabela de Origem" });
      expect(tinted(table)).toEqual(["Conversas de origem Orgânica"]);
      const marked = within(table).getByRole("link", { name: "Conversas de origem Orgânica" });
      expect(marked.textContent).not.toMatch(/destacad|melhor|maior/i);
    });
  });

  it("prints the origin Leads figure and a Tags count in the body colour", async () => {
    serveReport(remainderPopulated);
    renderPage();
    await screen.findByText("Total de Leads");

    // Both figures sit in plain body cells, which MUI paints text.primary. The
    // guard exists because they are easy to lose to an inherited colour: the
    // origin row is a role="link" and the `ver as N →` cell beside the figure
    // is deliberately dimmer (onSecondaryContainer), so a rule written one
    // level too high would tint the number with it.
    const origin = screen.getByRole("table", { name: "Tabela de Origem" });
    const leads = within(origin)
      .getByRole("link", { name: /Conversas de origem Anúncio/ })
      .querySelectorAll("td")[1] as HTMLElement;
    expect(leads).toHaveStyle({ color: "rgb(17, 17, 17)" });

    const tags = screen.getByRole("table", { name: "Conversas por tag" });
    const count = within(tags).getByText("2").closest("td") as HTMLElement;
    expect(count).toHaveStyle({ color: "rgb(17, 17, 17)" });
  });

  it("stretches a card row so every card reaches the tallest card's height", async () => {
    serveReport(dayResult);
    renderPage();
    const label = await screen.findByText("Total de Leads");

    // cardOf gives the KpiCard Box; its parent is the CardGrid that lays the
    // row out. A card grown by the grid still has to be a column for its own
    // foot rule to sit at the bottom, so both are asserted together.
    const card = cardOf(label);
    expect(card.parentElement).toHaveStyle({ display: "grid", alignItems: "stretch" });
    expect(card).toHaveStyle({ display: "flex", flexDirection: "column" });
  });

  it("paints the leads delta green and a falling response time green", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");

    const up = screen.getByText("+100%");
    expect(up.closest(".MuiChip-root")).toHaveStyle({ backgroundColor: SUCCESS_CONTAINER });
    const downIsBetter = screen.getByText("-15%");
    expect(downIsBetter.closest(".MuiChip-root")).toHaveStyle({ backgroundColor: SUCCESS_CONTAINER });
  });

  it("paints a 0% delta neutral and prints Cobertura as a percentage only", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        primary: {
          ...dayResult.insights.primary,
          meanFirstResponseMs: { value: 1000, deltaPct: 0 },
        },
      },
    });
    renderPage();
    const label = await screen.findByText("Tempo Médio de Resposta");

    const zero = screen.getByText("0%", { selector: ".MuiChip-label" });
    const zeroChip = zero.closest(".MuiChip-root");
    expect(zero.closest(".MuiChip-colorDefault")).toBeTruthy();
    expect(zeroChip).not.toHaveStyle({ backgroundColor: SUCCESS_CONTAINER });
    expect(zeroChip).not.toHaveStyle({ backgroundColor: ERROR_CONTAINER });
    expect(within(cardOf(label)).getByText(/^Cobertura 100% —/)).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+\/\d+\)/)).toBeNull();
  });

  it("prints Cobertura 38% for three of eight, with no fraction anywhere", async () => {
    serveReport({ ...dayResult, coverage: { answered: 3, total: 8 } });
    renderPage();

    const label = await screen.findByText("Tempo Médio de Resposta");
    expect(within(cardOf(label)).getByText(/^Cobertura 38% —/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\(?\b3\/8\b\)?/);
    expect(screen.queryByText(/\(\d+\/\d+\)/)).toBeNull();
  });

  it("navigates to Follow-up from the retornos vencidos chip", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ unansweredQuotes: 0, overdueReturns: 3, upcomingReturns: 0, waitingReply: 0 }),
      ),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();
    await user.click(await screen.findByRole("link", { name: "3 retornos vencidos" }));
    expect(await screen.findByText("Follow-up screen")).toBeInTheDocument();
  });

  it("shows metrics with no Cobertura line when novas are zero but ativas exist", async () => {
    serveReport(ativasOnlyResult);
    renderPage();

    const label = await screen.findByText("Tempo Médio de Resposta");
    expect(screen.queryByText(EMPTY_CUT_COPY)).not.toBeInTheDocument();
    expect(metricValue(label)).toBe("—");
    expect(within(cardOf(label)).queryByText(/Cobertura/)).toBeNull();
    expect(metricValue(screen.getByText("Total de Leads"))).toBe("0");
    // No stage retains from a zero first stage, so no retention and no drop sentence.
    expect(screen.queryByText(/seguem/)).toBeNull();
    expect(screen.queryByText(/A maior queda/)).toBeNull();
  });

  it("shows scheduled counts in their card when novas and ativas are zero", async () => {
    serveReport(scheduledOnlyResult);
    renderPage();

    expect(await screen.findByRole("table", { name: "Mensagens programadas" })).toBeInTheDocument();
    expect(screen.getByText("Enviadas")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_CUT_COPY)).not.toBeInTheDocument();
    // Two cards whenever one has rows: the tag card states its absence.
    expect(screen.getByText("Conversas por tag")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma conversa com tag no período.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Conversas por tag" })).toBeNull();
  });

  it("disables tag and campaign filters when their lists are empty", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");

    expect(screen.getByLabelText("Tag")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Campanha/Anúncio")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("table", { name: "Conversas por tag" })).not.toBeInTheDocument();
    expect(screen.queryByText(/espera média/)).not.toBeInTheDocument();
  });

  it("sends tagId for an active tag and omits inactive tags from the menu", async () => {
    const user = userEvent.setup();
    const tagIds: string[] = [];
    server.use(
      http.get("*/api/tags", () => HttpResponse.json([tagRetorno, tagInactive])),
      http.get("*/api/reports/conversations", ({ request }) => {
        const id = new URL(request.url).searchParams.get("tagId");
        if (id) {
          tagIds.push(id);
        }
        return HttpResponse.json(dayResult);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");
    await waitFor(() => {
      expect(screen.getByLabelText("Tag")).not.toHaveAttribute("aria-disabled", "true");
    });

    await user.click(screen.getByLabelText("Tag"));
    expect(await screen.findByRole("option", { name: "Retorno" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Arquivada" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Retorno" }));

    await waitFor(() => {
      expect(tagIds).toContain("tag-1");
    });
  });

  it("enables the campaign filter from byCampaign and sends campaignId", async () => {
    const user = userEvent.setup();
    const campaignIds: string[] = [];
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        const id = new URL(request.url).searchParams.get("campaignId");
        if (id) {
          campaignIds.push(id);
        }
        return HttpResponse.json(remainderPopulated);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");

    await waitFor(() => {
      expect(screen.getByLabelText("Campanha/Anúncio")).not.toHaveAttribute("aria-disabled", "true");
    });
    await user.click(screen.getByLabelText("Campanha/Anúncio"));
    await user.click(await screen.findByRole("option", { name: "camp-1" }));

    await waitFor(() => {
      expect(campaignIds).toContain("camp-1");
    });
  });

  it("renders the tag and scheduled cards, the wait caption, and the campaign rows behind the origin mark", async () => {
    serveReport(remainderPopulated);
    renderPage();

    expect(await screen.findByRole("table", { name: "Conversas por tag" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Mensagens programadas" })).toBeInTheDocument();
    expect(screen.getByText("Mensagens programadas por situação")).toBeInTheDocument();
    expect(screen.getByText("Retorno")).toBeInTheDocument();
    expect(screen.getByText("Programadas")).toBeInTheDocument();
    expect(screen.getByText("Com falha")).toBeInTheDocument();
    expect(screen.getByText("espera média 2s")).toBeInTheDocument();
    // The campaign breakdown is not a card: it waits behind the Tabela de Origem mark.
    expect(screen.queryByText("camp-1 · set-1 · ad-1")).toBeNull();
    expect(screen.queryByRole("table", { name: "Conversas por campanha/anúncio" })).toBeNull();

    await openMark("Tabela de Origem");

    expect(await screen.findByText("Por campanha ou anúncio")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Conversas por campanha/anúncio" })).getByText("camp-1 · set-1 · ad-1")).toBeInTheDocument();
  });

  it("keeps the attribution figures off the screen and the window sentence behind the Conversão mark", async () => {
    serveReport({
      ...dayResult,
      attribution: {
        rule: { windowDays: 30, version: 1 },
        scheduledReturn: { count: 2 },
        conversion: {
          converted: 1,
          total: 2,
          bySource: [
            { sourceType: "AD", converted: 1, total: 1 },
            { sourceType: "ORGANIC", converted: 0, total: 1 },
          ],
        },
      },
    } satisfies ReportResult);
    renderPage();
    await screen.findByText("Total de Leads");

    expect(screen.queryByRole("region", { name: "Associação no tempo" })).toBeNull();
    expect(screen.queryByText("Serviços Omie após mensagem programada enviada")).toBeNull();
    expect(screen.queryByText("1 de 2")).toBeNull();
    expect(screen.queryByText(/Janela de 30 dias/)).toBeNull();

    await openMark("Taxa de Conversão");

    expect(await screen.findByText("Como a atribuição funciona")).toBeInTheDocument();
    expect(screen.getByText(/Janela de 30 dias, versão 1 da regra/)).toBeInTheDocument();
    expect(screen.getByText(/não causalidade/)).toBeInTheDocument();
    expect(screen.queryByText(/causad/i)).toBeNull();
  });

  it("shows origin conversion count and percent when the rate is present", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        originRows: [
          { origin: "AD", leads: 2, conversions: 1, conversionRate: 0.5, revenue: 180 },
          { origin: "ORGANIC", leads: 1, conversions: 0, conversionRate: 0, revenue: 0 },
          { origin: "UNKNOWN", leads: 0, conversions: 0, conversionRate: null, revenue: 0 },
        ],
      },
    } satisfies ReportResult);
    renderPage();

    const table = await screen.findByRole("table", { name: "Tabela de Origem" });
    expect(within(table).getByText("1 (50%)")).toBeInTheDocument();
    expect(within(table).getByText("0 (0%)")).toBeInTheDocument();
    expect(within(table).getByText("—")).toBeInTheDocument();
    expect(within(table).getByText("ver as 2 →")).toBeInTheDocument();
    expect(within(table).getByText("ver as 0 →")).toBeInTheDocument();
    expect(within(table).queryByText("Invalid Date")).not.toBeInTheDocument();
  });

  it("renders no bare REP identifier anywhere at rest", async () => {
    serveReport(dayResult);
    renderPage();

    await screen.findByText("Total de Leads");
    expect(document.body.textContent).not.toMatch(/REP[-\s]?\d/i);
  });

  it("explains a metric in Portuguese behind its mark, closed until asked", async () => {
    serveReport(dayResult);
    renderPage();

    const mark = await screen.findByRole("button", { name: "O que é Total de Leads" });
    expect(mark).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/contadas pela hora da primeira mensagem/)).toBeNull();

    await userEvent.setup().click(mark);

    expect(await screen.findByText(/contadas pela hora da primeira mensagem/)).toBeInTheDocument();
    expect(mark).toHaveAttribute("aria-expanded", "true");
  });

  it("explains a section behind its heading mark in a card above the section", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");
    expect(screen.queryByText(/Quatro etapas encaixadas/)).toBeNull();

    await openMark("Funil de Vendas");

    const funnel = screen.getByRole("region", { name: "Funil de Vendas" });
    const explanation = await within(funnel).findByText(/Quatro etapas encaixadas/);
    const stage = within(funnel).getByRole("link", { name: "Conversas da etapa Novos Contatos" });
    expect(explanation.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives no mark to a metric it cannot explain", async () => {
    serveReport(dayResult);
    renderPage();

    await screen.findByText("Total de Leads");
    for (const button of screen.queryAllByRole("button", { name: /^O que é / })) {
      const label = button.getAttribute("aria-label")!.replace("O que é ", "");
      expect(METRIC_EXPLANATIONS[label]).toBeTruthy();
    }
  });

  it("says the counts are unavailable in Portuguese rather than omitting the strip", async () => {
    server.use(
      http.get("*/api/follow-up-counts", () => HttpResponse.json({ error: "boom" }, { status: 500 })),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();

    expect(await screen.findByText("Total de Leads")).toBeInTheDocument();
    const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
    expect(
      within(strip).getByText("Não foi possível carregar os alertas de follow-up."),
    ).toBeInTheDocument();
    expect(within(strip).queryByText(/^0 /)).toBeNull();
    expect(screen.queryByText("expirando hoje")).not.toBeInTheDocument();
  });

  it("keeps the alert strip when the report query fails", async () => {
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ overdueReturns: 6, unansweredQuotes: 4, waitingReply: 1, upcomingReturns: 2 }),
      ),
      http.get("*/api/reports/conversations", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Não foi possível carregar o relatório.")).toBeInTheDocument();
    const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
    expect(within(strip).getByText("6 retornos vencidos")).toBeInTheDocument();
  });

  it("draws only the counts that arrived, never a zero it does not know", async () => {
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ overdueReturns: 6, unansweredQuotes: 4 }),
      ),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();

    const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
    expect(within(strip).getByText("6 retornos vencidos")).toBeInTheDocument();
    expect(within(strip).getByText("4 orçamentos sem resposta")).toBeInTheDocument();
    expect(within(strip).queryByText(/mensagens aguardando resposta/)).toBeNull();
  });

  it("shows Total de Leads as 0 when the KPI value is null", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        primary: { ...dayResult.insights.primary, leads: { value: null } },
      },
    } satisfies ReportResult);
    renderPage();

    const label = await screen.findByText("Total de Leads");
    expect(metricValue(label)).toBe("0");
  });

  it("does not invent ad-set or ad ids on a campaign-only row", async () => {
    serveReport({
      ...dayResult,
      byCampaign: [{ campaignId: "camp-only", adSetId: null, adId: null, count: 2 }],
    } satisfies ReportResult);
    renderPage();
    await screen.findByText("Total de Leads");

    await openMark("Tabela de Origem");

    expect(await screen.findByText("camp-only")).toBeInTheDocument();
    expect(screen.queryByText(/camp-only ·/)).not.toBeInTheDocument();
  });

  it("states the absence of campaigns behind the origin mark when there are none", async () => {
    serveReport(dayResult);
    renderPage();
    await screen.findByText("Total de Leads");

    await openMark("Tabela de Origem");

    expect(await screen.findByText("Nenhuma campanha ou anúncio identificado no período.")).toBeInTheDocument();
  });

  it("paints a worsening leads delta as error", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        primary: { ...dayResult.insights.primary, leads: { value: 2, deltaPct: -20 } },
      },
    } satisfies ReportResult);
    renderPage();
    await screen.findByText("Total de Leads");

    const down = screen.getByText("-20%");
    expect(down.closest(".MuiChip-root")).toHaveStyle({ backgroundColor: ERROR_CONTAINER });
  });

  describe("the filter bar's set state, the clear control, and the delta basis", () => {
    it("shows no clear control while every filter is at its default", async () => {
      serveReport(dayResult);
      renderPage();

      await screen.findByText("Total de Leads");
      expect(screen.queryByRole("button", { name: /^Limpar/ })).toBeNull();
    });

    it("states how many filters it would clear, and clearing resets them", async () => {
      const user = userEvent.setup();
      let lastOrigin: string | null = null;
      server.use(
        http.get("*/api/reports/conversations", ({ request }) => {
          lastOrigin = new URL(request.url).searchParams.get("sourceType");
          return HttpResponse.json(remainderPopulated);
        }),
      );
      renderPage();
      await screen.findByText("Total de Leads");

      await user.click(screen.getByLabelText("Origem"));
      await user.click(await screen.findByRole("option", { name: "Anúncio" }));
      await waitFor(() => expect(lastOrigin).toBe("AD"));

      const clear = await screen.findByRole("button", { name: "Limpar 1 filtro" });
      await user.click(clear);

      await waitFor(() => expect(lastOrigin).toBeNull());
      expect(screen.queryByRole("button", { name: /^Limpar/ })).toBeNull();
    });

    it("counts origin, tag and campaign together, plural once two or more are set", async () => {
      const user = userEvent.setup();
      server.use(
        http.get("*/api/reports/conversations", () => HttpResponse.json(remainderPopulated)),
        http.get("*/api/tags", () =>
          HttpResponse.json([{ id: "t1", name: "vip", color: "primary", sortOrder: 0, active: true }]),
        ),
      );
      renderPage();
      await screen.findByText("Total de Leads");

      await user.click(screen.getByLabelText("Origem"));
      await user.click(await screen.findByRole("option", { name: "Anúncio" }));
      await waitFor(() => {
        expect(screen.getByLabelText("Tag")).not.toHaveAttribute("aria-disabled", "true");
      });
      await user.click(screen.getByLabelText("Tag"));
      await user.click(await screen.findByRole("option", { name: "vip" }));

      expect(await screen.findByRole("button", { name: "Limpar 2 filtros" })).toBeInTheDocument();
    });

    it("names the comparison rule and what an absent delta chip means", async () => {
      serveReport(dayResult);
      renderPage();

      expect(
        await screen.findByText(/período imediatamente anterior, do mesmo tamanho e sob os mesmos filtros/),
      ).toBeInTheDocument();
      expect(screen.getByText(/o card fica sem chip em vez de mostrar 0%/)).toBeInTheDocument();
    });

    it("states the immediately preceding period, same length, ending the day before the selected one starts", async () => {
      serveReport(dayResult);
      renderPage();

      const from = (await screen.findByLabelText("Início")).getAttribute("value")!;
      const to = screen.getByLabelText("Fim").getAttribute("value")!;
      const lengthDays =
        Math.round(
          (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
        ) + 1;
      const prevEnd = new Date(new Date(`${from}T00:00:00Z`).getTime() - 86_400_000);
      const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * 86_400_000);
      const short = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const expected = `${short(prevStart)} a ${short(prevEnd)}/${prevEnd.getUTCFullYear()}`;

      expect(await screen.findByText(expected)).toBeInTheDocument();
    });

    it("renders every named section at once — no section is collapsed", async () => {
      serveReport(dayResult);
      renderPage();

      expect(await screen.findByText("Total de Leads")).toBeInTheDocument();
      for (const name of [
        "Indicadores principais",
        "Funil de Vendas",
        "Tabela de Origem",
        "Atendimento e clientes",
        "Tags e mensagens programadas",
      ]) {
        expect(screen.getByRole("region", { name })).toBeInTheDocument();
      }
      expect(screen.queryByRole("button", { name: /detalhe/i })).toBeNull();
    });
  });
});

describe("subject bands, deduplicated figures", () => {
  it("names its sections by subject, and none by a time basis", async () => {
    serveReport({
      ...dayResult,
      byTag: [{ tagId: "tag-1", name: "Retorno", count: 2 }],
    } satisfies ReportResult);
    renderPage();

    await screen.findByText("Total de Leads");
    const names = screen.getAllByRole("region").map((section) => section.getAttribute("aria-label"));
    expect(names).toEqual(
      expect.arrayContaining([
        "Indicadores principais",
        "Funil de Vendas",
        "Tabela de Origem",
        "Atendimento e clientes",
        "Tags e mensagens programadas",
      ]),
    );
    for (const name of names) {
      expect(name).not.toMatch(/período|momento|vida|hoje/i);
    }
  });

  it("prints the first-response mean exactly once, even with the Tempo Médio mark open", async () => {
    serveReport(dayResult);
    renderPage();

    // dayResult's mean is 1000 ms on both firstResponse.meanMs and
    // insights.primary.meanFirstResponseMs — the same number, which is why the
    // detail behind the mark must not repeat it.
    const label = await screen.findByText("Tempo Médio de Resposta");
    expect(metricValue(label)).toBe("1s");
    expect(screen.getAllByText("1s")).toHaveLength(1);

    await openMark("Tempo Médio de Resposta");

    await screen.findByText("Primeira resposta");
    expect(screen.getAllByText("1s")).toHaveLength(1);
    expect(screen.queryByText(/\(\d+\/\d+\)/)).toBeNull();
  });

  it("shows Orçamentos sem resposta in the strip and not as a card", async () => {
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ unansweredQuotes: 5, overdueReturns: 0, upcomingReturns: 0, waitingReply: 8 }),
      ),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();

    const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
    expect(within(strip).getByText("5 orçamentos sem resposta")).toBeInTheDocument();
    expect(screen.queryByText("Orçamentos sem resposta")).toBeNull();
  });

  it("distinguishes the period figure from the strip's present-moment one, explanation intact", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/follow-up-counts", () =>
        HttpResponse.json({ unansweredQuotes: 0, overdueReturns: 0, upcomingReturns: 0, waitingReply: 8 }),
      ),
      http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
    );
    renderPage();

    const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
    expect(within(strip).getByText("8 mensagens aguardando resposta")).toBeInTheDocument();
    expect(screen.getByText("Conversas sem resposta no período")).toBeInTheDocument();
    expect(screen.queryByText("Sem resposta")).toBeNull();

    expect(METRIC_EXPLANATIONS["Conversas sem resposta no período"]).toBeTruthy();
    expect(METRIC_EXPLANATIONS["Conversas sem resposta"]).toBeUndefined();
    const mark = screen.getByRole("button", { name: "O que é Conversas sem resposta no período" });
    await user.click(mark);
    expect(await screen.findByText(/Não confundir com o alerta no topo/)).toBeInTheDocument();
  });

  it("states one absence and draws no card when neither tags nor scheduled rows exist", async () => {
    serveReport(dayResult);
    renderPage();

    const section = await screen.findByRole("region", { name: "Tags e mensagens programadas" });
    expect(within(section).getByText("Nenhuma tag nem mensagem programada no período.")).toBeInTheDocument();
    expect(within(section).queryByRole("table")).toBeNull();
    expect(within(section).queryByText("Conversas por tag")).toBeNull();
  });

  it("draws two cards when only tags have rows, the scheduled card stating its absence", async () => {
    serveReport({
      ...dayResult,
      byTag: [{ tagId: "tag-1", name: "Retorno", count: 2 }],
    } satisfies ReportResult);
    renderPage();

    const section = await screen.findByRole("region", { name: "Tags e mensagens programadas" });
    expect(within(section).getByRole("table", { name: "Conversas por tag" })).toBeInTheDocument();
    expect(within(section).getByText("Mensagens programadas por situação")).toBeInTheDocument();
    expect(within(section).getByText("Nenhuma mensagem programada no período.")).toBeInTheDocument();
    expect(within(section).queryByRole("table", { name: "Mensagens programadas" })).toBeNull();
    expect(within(section).queryByText("Nenhuma tag nem mensagem programada no período.")).toBeNull();
  });
});

describe("funnel step rates and drill-through", () => {
  it("draws the retention row as shares of the preceding stage, the weakest in the error colour, with the drop sentence", async () => {
    serveReport(funnelResult);
    renderPage();

    const funnel = await screen.findByRole("region", { name: "Funil de Vendas" });
    expect(within(funnel).getByText("80% seguem")).toBeInTheDocument();
    const weakest = within(funnel).getByText("37,5% seguem");
    expect(within(funnel).getByText("40% seguem")).toBeInTheDocument();
    expect(weakest).toHaveStyle({ color: "rgb(179, 38, 30)" });
    expect(within(funnel).getByText("80% seguem")).not.toHaveStyle({ color: "rgb(179, 38, 30)" });
    expect(
      within(funnel).getByText(
        "A maior queda é de Em atendimento para Orçamento Enviado: de 80 conversas atendidas, 30 receberam orçamento.",
      ),
    ).toBeInTheDocument();
    expect(within(funnel).getByText("ver as 100")).toBeInTheDocument();
    expect(within(funnel).getByText("ver as 12")).toBeInTheDocument();
    expect(within(funnel).queryByText(/retém/)).toBeNull();
  });

  it("shows no retention figure after a zero stage and names the collapse into it", async () => {
    serveReport(dayResult);
    renderPage();

    const funnel = await screen.findByRole("region", { name: "Funil de Vendas" });
    // dayResult's funnel is 2 / 2 / 0 / 0: Serviços Feitos follows a zero stage.
    expect(within(funnel).getByText("100% seguem")).toBeInTheDocument();
    expect(within(funnel).getByText("0% seguem")).toBeInTheDocument();
    expect(within(funnel).getAllByText(/seguem/)).toHaveLength(2);
    expect(
      within(funnel).getByText(
        "A maior queda é de Em atendimento para Orçamento Enviado: de 2 conversas atendidas, 0 receberam orçamento.",
      ),
    ).toBeInTheDocument();
  });

  it("a funnel stage navigates to Conversas carrying that stage and the report's own period", async () => {
    serveReport(dayResult);
    const user = userEvent.setup();
    renderPage();

    const from = (await screen.findByLabelText("Início")).getAttribute("value");
    const to = screen.getByLabelText("Fim").getAttribute("value");
    await screen.findByRole("region", { name: "Funil de Vendas" });
    await user.click(screen.getByRole("link", { name: "Conversas da etapa Em atendimento" }));

    const echoed = await screen.findByTestId("inbox-route");
    const params = new URLSearchParams(echoed.textContent ?? "");
    expect(params.get("stage")).toBe("emAtendimento");
    expect(params.get("from")).toBe(from);
    expect(params.get("to")).toBe(to);
    expect(params.has("origin")).toBe(false);
  });

  it("an origin row navigates to Conversas carrying that origin and the report's own period", async () => {
    serveReport({
      ...dayResult,
      insights: {
        ...dayResult.insights,
        originRows: [
          { origin: "AD", leads: 10, conversions: 3, conversionRate: 0.3, revenue: 900 },
          { origin: "ORGANIC", leads: 4, conversions: 1, conversionRate: 0.25, revenue: 300 },
          { origin: "UNKNOWN", leads: 2, conversions: 0, conversionRate: null, revenue: 0 },
        ],
      },
    });
    const user = userEvent.setup();
    renderPage();

    const from = (await screen.findByLabelText("Início")).getAttribute("value");
    const to = screen.getByLabelText("Fim").getAttribute("value");
    const row = await screen.findByRole("link", { name: "Conversas de origem Anúncio" });
    expect(within(row).getByText("ver as 10 →")).toBeInTheDocument();
    await user.click(row);

    const echoed = await screen.findByTestId("inbox-route");
    const params = new URLSearchParams(echoed.textContent ?? "");
    expect(params.get("origin")).toBe("AD");
    expect(params.get("from")).toBe(from);
    expect(params.get("to")).toBe(to);
    expect(params.has("stage")).toBe(false);
  });

  it("an origin row opens its inbox filter from the keyboard, not only a click", async () => {
    serveReport(dayResult);
    renderPage();

    const row = await screen.findByRole("link", { name: "Conversas de origem Anúncio" });
    row.focus();
    await userEvent.setup().keyboard("{Enter}");

    const echoed = await screen.findByTestId("inbox-route");
    expect(new URLSearchParams(echoed.textContent ?? "").get("origin")).toBe("AD");
  });
});

it("renders the customer band on both palettes", async () => {
  serveReport(dayResult);
  usePalette.setState({ paletteId: "yellow-cta" });
  const first = renderPage();
  expect(await screen.findByRole("region", { name: "Atendimento e clientes" })).toBeInTheDocument();
  first.unmount();

  usePalette.getState().setPaletteId("black-cta");
  renderPage();
  const section = await screen.findByRole("region", { name: "Atendimento e clientes" });
  expect(section).toBeInTheDocument();
  expect(usePalette.getState().paletteId).toBe("black-cta");
});

it("paints a RISING response time red, because lower is better on that card", async () => {
  // D26's missing outcome. The two green cases pinned +100 on Leads and −15 on
  // Tempo Médio, and the red case pinned −20 on Leads — so `lowerIsBetter` was
  // only ever sampled on a delta that fell. A card whose flag was dropped
  // entirely still passed all three: +100 green, −15 green under the plain
  // rule too, −20 red. This is the cell that separates them.
  serveReport({
    ...dayResult,
    insights: {
      ...dayResult.insights,
      primary: {
        ...dayResult.insights.primary,
        meanFirstResponseMs: { value: 1000, deltaPct: 25 },
      },
    },
  } satisfies ReportResult);
  renderPage();
  await screen.findByText("Tempo Médio de Resposta");

  const slower = screen.getByText("+25%");
  expect(slower.closest(".MuiChip-root")).toHaveStyle({ backgroundColor: ERROR_CONTAINER });
  // Leads rose by the same sign on the same render and stays green, so the
  // assertion above is about the flag rather than about the sign.
  expect(screen.getByText("+100%").closest(".MuiChip-root")).toHaveStyle({
    backgroundColor: SUCCESS_CONTAINER,
  });
});

it("switches duration units exactly at a minute and at an hour, not one second early", async () => {
  // BVA on `formatDuration`'s two ordered edges, in the along-the-conversation
  // block because it is the only one printing three durations at once. The
  // suite already carried 1s, 1m 1s, 1h 0m, 2s, 2m 0s and 2h 0m — every one of
  // them comfortably inside a partition, so an off-by-one on either comparison
  // (`>= 0` for hours, say) went unnoticed. 59s and 59m 59s are edge−1; 1m 0s
  // is the minute edge itself, where seconds fall to zero and must still print.
  serveReport({
    ...dayResult,
    subsequentResponse: {
      meanMs: 59_000,
      medianMs: 60_000,
      p90Ms: 3_599_000,
      eligibleCount: 3,
      inboundTotal: 3,
    },
  } satisfies ReportResult);
  renderPage();
  await screen.findByText("Tempo Médio de Resposta");

  await openMark("Tempo Médio de Resposta");

  const along = (await screen.findByText("Ao longo da conversa")).parentElement as HTMLElement;
  expect(within(along).getByText("59s")).toBeInTheDocument();
  expect(within(along).getByText("1m 0s")).toBeInTheDocument();
  expect(within(along).getByText("59m 59s")).toBeInTheDocument();
});

describe("what makes a cut empty, as a decision table over its settled inputs", () => {
  // `isEmptyCut` combines four conditions. The spec names all four: novas,
  // ativas, scheduled rows, and attribution rows (relatorios/spec.md:59 and
  // the serviced-return scenario at :73-75).
  it.each([
    { cut: "nothing at all", result: emptyResult, isEmpty: true },
    { cut: "novas only", result: novasOnlyResult, isEmpty: false },
    { cut: "ativas only", result: ativasOnlyResult, isEmpty: false },
    { cut: "mensagens programadas only", result: scheduledOnlyResult, isEmpty: false },
    { cut: "atribuição only", result: attributionOnlyResult, isEmpty: false },
  ])("$cut → empty state: $isEmpty", async ({ result, isEmpty }) => {
    serveReport(result);
    renderPage();

    if (isEmpty) {
      expect(await screen.findByText(EMPTY_CUT_COPY)).toBeInTheDocument();
      expect(screen.queryByText("Total de Leads")).toBeNull();
      return;
    }
    expect(await screen.findByText("Total de Leads")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_CUT_COPY)).toBeNull();
  });
});

// The strip SHALL render even when a 200 carries none of the three chip
// counts (relatorios/spec.md:475). That is not the 500 path: unavailable copy
// stays on a failed counts read. This case asserts only that the region exists.
it("renders the strip at all when the counts payload carries none of the three chips", async () => {
  server.use(
    http.get("*/api/follow-up-counts", () => HttpResponse.json({ upcomingReturns: 2 })),
    http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
  );
  renderPage();
  await screen.findByText("Total de Leads");

  expect(screen.getByRole("region", { name: "Alertas de follow-up" })).toBeInTheDocument();
});

it("draws the one count that arrived when the other two are absent", async () => {
  // The mirror of the existing partial case, which supplied overdueReturns and
  // unansweredQuotes and omitted waitingReply: those two guards had only ever
  // run on a count that was present, so a chip pushed unconditionally would
  // have been caught for waitingReply alone.
  server.use(
    http.get("*/api/follow-up-counts", () => HttpResponse.json({ waitingReply: 8 })),
    http.get("*/api/reports/conversations", () => HttpResponse.json(dayResult)),
  );
  renderPage();

  const strip = await screen.findByRole("region", { name: "Alertas de follow-up" });
  expect(within(strip).getByText("8 mensagens aguardando resposta")).toBeInTheDocument();
  expect(within(strip).queryByText(/retornos vencidos/)).toBeNull();
  expect(within(strip).queryByText(/orçamentos sem resposta/)).toBeNull();
  expect(within(strip).getAllByRole("link")).toHaveLength(1);
});

describe("every funnel stage opens the cut its own caption promised", () => {
  // Task 3.11 made the inbox's stage filter cumulative so `ver as 30` opens the
  // 30 the funnel counted. That task's test covers the READER (the inbox
  // adapters); this covers the WRITER — that each stage offers its own count
  // and links with its own key. Only emAtendimento was ever sampled, so three
  // of the four stage keys were never asserted to reach the URL at all, and a
  // link hard-coded to one stage would have passed.
  //
  // Funnel captions come from FUNNEL_STAGE_LABELS (title case). Thread
  // captions live in THREAD_STAGE_LABELS. Selecting through the funnel map
  // keeps these cases pointed at the right element.
  const stageCells = [
    { key: "novosContatos", count: 100 },
    { key: "emAtendimento", count: 80 },
    // The spec names this pair itself: "the Orçamento Enviado stage, which
    // reads `ver as 30`" (relatorios/spec.md:426).
    { key: "orcamentoEnviado", count: 30 },
    { key: "servicosFeitos", count: 12 },
  ] satisfies { key: ConversationPipelineStage; count: number }[];

  it.each(stageCells)("$key reads ver as $count and opens its own cut", async ({ key, count }) => {
    serveReport(funnelResult);
    const user = userEvent.setup();
    renderPage();

    const from = (await screen.findByLabelText("Início")).getAttribute("value");
    const to = screen.getByLabelText("Fim").getAttribute("value");
    const stage = await screen.findByRole("link", {
      name: `Conversas da etapa ${FUNNEL_STAGE_LABELS[key]}`,
    });
    // The caption and the link are one promise: a stage offering `ver as 30`
    // and opening a different stage's cut is the defect 3.11 fixed, seen from
    // this side.
    expect(within(stage).getByText(`ver as ${count}`)).toBeInTheDocument();

    await user.click(stage);

    const params = new URLSearchParams((await screen.findByTestId("inbox-route")).textContent ?? "");
    expect(params.get("stage")).toBe(key);
    expect(params.get("from")).toBe(from);
    expect(params.get("to")).toBe(to);
    // A stage cuts by stage only; carrying an origin as well would narrow the
    // set below the count the caption just promised.
    expect(params.has("origin")).toBe(false);
  });
});

describe("the origin row's keyboard contract", () => {
  it("opens the origin row's cut from the space bar as well as Enter", async () => {
    serveReport(dayResult);
    renderPage();

    const row = await screen.findByRole("link", { name: "Conversas de origem Anúncio" });
    row.focus();
    await userEvent.setup().keyboard(" ");

    const echoed = await screen.findByTestId("inbox-route");
    expect(new URLSearchParams(echoed.textContent ?? "").get("origin")).toBe("AD");
  });

  it("stays put on a key that is neither Enter nor space", async () => {
    // The false arm of that handler, and the one that matters: a row which
    // navigated on any keypress would swallow arrow-key scrolling and Tab, and
    // both existing keyboard assertions are positive, so nothing held it.
    serveReport(dayResult);
    renderPage();

    const row = await screen.findByRole("link", { name: "Conversas de origem Anúncio" });
    row.focus();
    await userEvent.setup().keyboard("{ArrowDown}");

    expect(screen.queryByTestId("inbox-route")).toBeNull();
    expect(screen.getByRole("table", { name: "Tabela de Origem" })).toBeInTheDocument();
  });
});

describe("the period the screen asks the API for", () => {
  // The clock is pinned so both expectations below can be written as literal
  // strings taken from the requirement, instead of being recomputed in the
  // test with the same arithmetic the component uses — which would agree with
  // a wrong implementation. 2026-03-07 is chosen so the seven-day default
  // window opens on the 1st of a month and its preceding period ends on
  // 28 February, the short-month edge, in a non-leap year.
  const NOW = new Date("2026-03-07T12:00:00.000Z");

  beforeEach(() => {
    // `shouldAdvanceTime` keeps MSW and TanStack Query settling on their own;
    // only the starting instant is pinned.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends São Paulo midnight as the start and the next midnight after the end", async () => {
    // The requirement evaluates a nova's membership on `America/Sao_Paulo`
    // calendar boundaries over the half-open interval [periodStart, periodEnd),
    // and this screen is what turns two picked calendar dates into those two
    // instants. Nothing asserted them before: every filter test read the params
    // it filtered on and let these two through untouched. São Paulo has no DST,
    // so local midnight is 03:00Z the year round, and the end is the midnight
    // that OPENS the day after the selected one — which is what makes the last
    // selected day count in full while the next day does not count at all.
    const seen: URL[] = [];
    server.use(
      http.get("*/api/reports/conversations", ({ request }) => {
        seen.push(new URL(request.url));
        return HttpResponse.json(dayResult);
      }),
    );
    renderPage();
    await screen.findByText("Total de Leads");

    expect(screen.getByLabelText("Início")).toHaveValue("2026-03-01");
    expect(screen.getByLabelText("Fim")).toHaveValue("2026-03-08");
    expect(seen[0]?.searchParams.get("periodStart")).toBe("2026-03-01T03:00:00.000Z");
    expect(seen[0]?.searchParams.get("periodEnd")).toBe("2026-03-09T03:00:00.000Z");
  });

  it("names a comparison period of the same length ending the day before this one starts", async () => {
    // 01/03–08/03 is eight days, so the comparison runs 21/02–28/02: same
    // length, ending the day before. February gives the case a short month to
    // cross, which a window inside one 31-day month would never exercise.
    serveReport(dayResult);
    renderPage();

    await screen.findByText("Total de Leads");
    expect(screen.getByText("21/02 a 28/02/2026")).toBeInTheDocument();
  });
});
