/**
 * Manager reports screen — conversation volume and response-time metrics by period.
 *
 * Laid out card for card to the PDF export of the approved Relatórios artboard
 * (align-shipped-ui-to-pdf-artboards): alert strip, label-above filter bar,
 * then five bands — Indicadores principais, Funil de Vendas, Tabela de Origem,
 * Atendimento e clientes, Tags e mensagens programadas. What used to be seven
 * extra cards (period table, response-time breakdowns, attribution, campaign
 * rows) now sits behind the mark of the metric it explains.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import type {
  ConversationPipelineStage,
  ConversationSourceType,
  FollowUpOptionalCounts,
  ReportGranularity,
  ReportKpi,
  ReportResult,
} from "@select-lub/shared-types";
import { fetchConversationReport, fetchFollowUpCounts, fetchTags } from "./api.js";
import { inboxDrillLink, FUNNEL_STAGE_LABELS } from "./conversas/inboxLink.js";
import { LabeledInput, LabeledSelect, MenuItem } from "./LabeledField.js";
import { useMetricWhy } from "./MetricWhy.js";
import { cardSx, PageSection, PageShell } from "./PageShell.js";
import { funnelStage, TYPE_SCALE } from "./theme.js";

const EMPTY_CUT_COPY =
  "Nenhuma conversa no recorte selecionado. Ajuste o período ou os filtros.";

/** The artboard's `.metric-label`: an upper-cased caption, drawn by CSS so the DOM keeps the written word. */
const METRIC_LABEL_SX = {
  fontSize: TYPE_SCALE.caption,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "text.secondary",
} as const;

/** A `ver as N` caption: the drill-through's visible text, in the accent colour and never gold. */
const GO_SX = {
  fontSize: TYPE_SCALE.caption,
  fontWeight: 600,
  color: "onSecondaryContainer",
  whiteSpace: "nowrap",
} as const;

/**
 * Formats a millisecond duration for report summary cards.
 * @param ms - Elapsed milliseconds from the API; null renders an em dash.
 * @returns Human-readable duration string in Portuguese units.
 */
function formatDuration(ms: number | null) {
  if (ms === null) {
    return "—";
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * True when `value` is a complete `YYYY-MM-DD` calendar date.
 *
 * @param value - Picker value; empty or partial while the reader is editing.
 */
function isYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Converts a calendar date in America/Sao_Paulo to an ISO instant for the report query.
 *
 * A cleared picker is unbounded: civil-time start for Início, a far-future
 * exclusive end for Fim, so the query still has parseable instants. An empty
 * string used to become `Date.UTC(0, NaN, NaN)` and throw, unmounting the page.
 *
 * @param dateYmd - Local date as `YYYY-MM-DD` from the date picker, or empty when unbounded.
 * @param endOfDayExclusive - When true, returns midnight at the start of the next local day (exclusive period end).
 * @returns UTC ISO string aligned to São Paulo midnight (UTC-3).
 */
function toPeriodInstant(dateYmd: string, endOfDayExclusive: boolean) {
  const ymd = isYmd(dateYmd) ? dateYmd : endOfDayExclusive ? "9999-12-31" : "1970-01-01";
  const [y, m, d] = ymd.split("-").map(Number);
  const utcMs = Date.UTC(y!, m! - 1, d! + (endOfDayExclusive ? 1 : 0), 3, 0, 0, 0);
  return new Date(utcMs).toISOString();
}

/**
 * Default report window: last seven local days through tomorrow's midnight in São Paulo.
 * @returns Start and end dates as `YYYY-MM-DD` strings for the date pickers.
 */
function defaultRange() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6, 3));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

/**
 * The immediately preceding period, same inclusive length, that the delta
 * chips compare against — computed the same way the artboard states it in
 * words, so the line and the chips can never silently disagree.
 *
 * @param startYmd - Selected period start, `YYYY-MM-DD`.
 * @param endYmd - Selected period end, `YYYY-MM-DD` (inclusive).
 * @returns The prior period's start and end, same length, ending the day
 *   before `startYmd` begins.
 */
function previousPeriod(startYmd: string, endYmd: string) {
  const start = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start.getTime() - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(prevStart), end: fmt(prevEnd) };
}

/**
 * "04/07 a 31/07/2026" — the artboard's exact phrasing for stating a period
 * in prose, distinct from {@link formatPeriodChip}'s chip form.
 */
function formatPeriodProse(startYmd: string, endYmd: string) {
  const short = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return `${short(startYmd)} a ${short(endYmd)}/${endYmd.slice(0, 4)}`;
}

/** "03/08" for a bucket start, whether the API sent a date or an instant. */
function formatBucketDay(bucketStart: string) {
  return `${bucketStart.slice(8, 10)}/${bucketStart.slice(5, 7)}`;
}

function scheduledHasRows(scheduled: ReportResult["scheduled"]) {
  return scheduled.scheduled + scheduled.sent + scheduled.cancelled + scheduled.failed > 0;
}

function attributionHasRows(attribution: ReportResult["attribution"]) {
  return attribution.scheduledReturn.count > 0 || attribution.conversion.total > 0;
}

function isEmptyCut(data: ReportResult) {
  return (
    data.newConversationCount === 0 &&
    data.activeConversationCount === 0 &&
    !scheduledHasRows(data.scheduled) &&
    !attributionHasRows(data.attribution)
  );
}

function meanWaitMs(items: ReportResult["unanswered"]["items"]) {
  if (items.length === 0) {
    return null;
  }
  return Math.round(items.reduce((sum, item) => sum + item.waitMs, 0) / items.length);
}

function campaignRowLabel(row: ReportResult["byCampaign"][number]) {
  const parts = [row.campaignId];
  if (row.adSetId) {
    parts.push(row.adSetId);
  }
  if (row.adId) {
    parts.push(row.adId);
  }
  return parts.join(" · ");
}

function formatPercent(value: number | null) {
  if (value == null) {
    return "—";
  }
  return `${Math.round(value * 100)}%`;
}

/** "37,5%" — one decimal at most, Brazilian comma, for the funnel's retention row. */
function formatRetention(ratio: number) {
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(ratio * 100)}%`;
}

function formatMoney(value: number | null) {
  if (value == null) {
    return "—";
  }
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDelta(deltaPct: number) {
  const rounded = Math.round(deltaPct);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

const GRANULARITY_LABEL: Record<ReportGranularity, string> = {
  day: "Dia",
  week: "Semana",
  month: "Mês",
};

const SOURCE_TYPE_LABEL: Record<ConversationSourceType, string> = {
  AD: "Anúncio",
  ORGANIC: "Orgânica",
  UNKNOWN: "Desconhecida",
};

/** The look of a filter set away from its default (artboard `.filter-on`). */
const FILTER_ON_SX = {
  bgcolor: "secondaryContainer",
  fontWeight: 600,
  "& .MuiOutlinedInput-notchedOutline": { borderColor: "onSecondaryContainer" },
} as const;

/**
 * Reports dashboard at `/relatorios` for owners and managers reviewing team coverage.
 *
 * @returns Date-range controls and metric cards fed by `GET /reports/conversations`.
 */
export function RelatoriosPage() {
  const defaults = useMemo(() => defaultRange(), []);
  const [periodStartDate, setPeriodStartDate] = useState(defaults.start);
  const [periodEndDate, setPeriodEndDate] = useState(defaults.end);
  const [granularity, setGranularity] = useState<ReportGranularity>("day");
  const [origin, setOrigin] = useState<"ALL" | ConversationSourceType>("ALL");
  const [tagId, setTagId] = useState("ALL");
  const [campaignId, setCampaignId] = useState("ALL");
  const [seenCampaignIds, setSeenCampaignIds] = useState<string[]>([]);
  // Origin, tag and campaign are FILTERS in the sense the clear control means:
  // narrowing which conversations count. Period and granularity reshape how
  // the same set is read, not which conversations are in it, so neither counts.
  const filtersSetCount = [origin !== "ALL", tagId !== "ALL", campaignId !== "ALL"].filter(
    Boolean,
  ).length;
  const clearFilters = () => {
    setOrigin("ALL");
    setTagId("ALL");
    setCampaignId("ALL");
  };

  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: fetchTags });
  const activeTags = (tagsQuery.data ?? []).filter((tag) => tag.active);

  const query = {
    periodStart: toPeriodInstant(periodStartDate, false),
    periodEnd: toPeriodInstant(periodEndDate, true),
    granularity,
    ...(origin === "ALL" ? {} : { sourceType: origin }),
    ...(tagId === "ALL" ? {} : { tagId }),
    ...(campaignId === "ALL" ? {} : { campaignId }),
  };

  const reportQuery = useQuery({
    queryKey: ["reports", "conversations", query],
    queryFn: () => fetchConversationReport(query),
    // A filter change keeps the current report on screen until the new one
    // lands: the cards stay mounted, so a mark the reader opened (the period
    // table behind Total de Leads, say) stays open and simply reaggregates,
    // instead of collapsing behind a skeleton and coming back closed.
    placeholderData: keepPreviousData,
  });
  const followUpQuery = useQuery({ queryKey: ["follow-up-counts"], queryFn: fetchFollowUpCounts });

  useEffect(() => {
    const rows = reportQuery.data?.byCampaign ?? [];
    if (rows.length === 0) {
      return;
    }
    setSeenCampaignIds((previous) => {
      const merged = new Set(previous);
      for (const row of rows) {
        merged.add(row.campaignId);
      }
      return [...merged];
    });
  }, [reportQuery.data]);

  const tagFilterDisabled = activeTags.length === 0;
  const campaignFilterDisabled = seenCampaignIds.length === 0 && campaignId === "ALL";

  return (
    <PageShell current="/relatorios" title="Relatórios">
      <FollowUpAlertStrip counts={followUpQuery.data} failed={followUpQuery.isError} />

      <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <LabeledInput
          id="relatorios-inicio"
          label="Início"
          type="date"
          value={periodStartDate}
          onChange={(event) => setPeriodStartDate(event.target.value)}
        />
        <LabeledInput
          id="relatorios-fim"
          label="Fim"
          type="date"
          value={periodEndDate}
          onChange={(event) => setPeriodEndDate(event.target.value)}
        />
        <LabeledSelect<ReportGranularity>
          id="relatorios-granularidade"
          label="Granularidade"
          value={granularity}
          onChange={(event) => setGranularity(event.target.value as ReportGranularity)}
          sx={{ minWidth: 132 }}
        >
          <MenuItem value="day">Dia</MenuItem>
          <MenuItem value="week">Semana</MenuItem>
          <MenuItem value="month">Mês</MenuItem>
        </LabeledSelect>
        <LabeledSelect<"ALL" | ConversationSourceType>
          id="relatorios-origem"
          label="Origem"
          value={origin}
          onChange={(event) => setOrigin(event.target.value as "ALL" | ConversationSourceType)}
          sx={{ minWidth: 132, ...(origin !== "ALL" ? FILTER_ON_SX : {}) }}
        >
          <MenuItem value="ALL">Todas</MenuItem>
          <MenuItem value="AD">Anúncio</MenuItem>
          <MenuItem value="ORGANIC">Orgânica</MenuItem>
          <MenuItem value="UNKNOWN">Desconhecida</MenuItem>
        </LabeledSelect>
        <LabeledSelect<string>
          id="relatorios-tag"
          label="Tag"
          value={tagId}
          disabled={tagFilterDisabled}
          onChange={(event) => setTagId(event.target.value)}
          sx={{ minWidth: 132, ...(tagId !== "ALL" ? FILTER_ON_SX : {}) }}
        >
          <MenuItem value="ALL">Todas</MenuItem>
          {activeTags.map((tag) => (
            <MenuItem key={tag.id} value={tag.id}>
              {tag.name}
            </MenuItem>
          ))}
        </LabeledSelect>
        <LabeledSelect<string>
          id="relatorios-campanha"
          label="Campanha/Anúncio"
          value={campaignId}
          disabled={campaignFilterDisabled}
          onChange={(event) => setCampaignId(event.target.value)}
          sx={{ minWidth: 160, ...(campaignId !== "ALL" ? FILTER_ON_SX : {}) }}
        >
          <MenuItem value="ALL">Todas</MenuItem>
          {seenCampaignIds.map((id) => (
            <MenuItem key={id} value={id}>
              {id}
            </MenuItem>
          ))}
        </LabeledSelect>
        {filtersSetCount > 0 ? (
          <Button variant="outlined" size="small" onClick={clearFilters}>
            {`Limpar ${filtersSetCount} ${filtersSetCount === 1 ? "filtro" : "filtros"}`}
          </Button>
        ) : null}
      </Stack>

      <ReportBody
        query={reportQuery}
        periodFrom={periodStartDate}
        periodTo={periodEndDate}
        granularity={granularity}
      />
    </PageShell>
  );
}

/**
 * Renders report metrics after the period filters resolve.
 * @param query - TanStack query for `GET /reports/conversations`.
 * @param periodFrom - The report's own period start, `YYYY-MM-DD`, carried onto every drill-through link.
 * @param periodTo - The report's own period end, `YYYY-MM-DD`.
 * @param granularity - Names the period column of the bucket table behind the Leads mark.
 */
function ReportBody({
  query,
  periodFrom,
  periodTo,
  granularity,
}: {
  query: {
    isLoading: boolean;
    isError: boolean;
    data?: ReportResult;
    refetch: () => void;
  };
  periodFrom: string;
  periodTo: string;
  granularity: ReportGranularity;
}) {
  if (query.isLoading) {
    return (
      <Stack spacing={1} aria-busy="true">
        <Skeleton variant="rounded" height={48} />
        <Skeleton variant="rounded" height={160} />
      </Stack>
    );
  }

  if (query.isError) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => query.refetch()}>
            Tentar de novo
          </Button>
        }
      >
        Não foi possível carregar o relatório.
      </Alert>
    );
  }

  const data = query.data;
  if (!data || isEmptyCut(data)) {
    return <Alert severity="info">{EMPTY_CUT_COPY}</Alert>;
  }

  const waitMean = meanWaitMs(data.unanswered.items);
  const { insights, attribution } = data;
  const { secondary } = insights;
  const previous =
    isYmd(periodFrom) && isYmd(periodTo) ? previousPeriod(periodFrom, periodTo) : null;
  const coverageLine =
    data.coverage.total === 0
      ? undefined
      : `Cobertura ${Math.round((data.coverage.answered / data.coverage.total) * 100)}% — conversas sem evento de saída observado ficam de fora.`;
  const attributionDetail = (
    <DetailBlock label="Como a atribuição funciona">
      <Typography sx={{ fontSize: TYPE_SCALE.body }}>
        Janela de {attribution.rule.windowDays} dias, versão {attribution.rule.version} da regra. Um
        serviço conta para uma conversa quando acontece dentro da janela depois dela — é associação
        no tempo, não causalidade.
      </Typography>
    </DetailBlock>
  );
  // An absent value says why it is absent, and says it in terms of its OWN
  // base. The two cards below go blank for different reasons — Clientes
  // perdidos has nobody who could fall due, Receita média has nothing to
  // divide by — so one shared sentence would tell the reader less than the
  // line Taxa de Aprovação already carries. The artboard draws all three with
  // values, so this case is designed here rather than copied from it.
  const lapsedCaption =
    secondary.lapsedCustomers == null
      ? "nenhum cliente com serviço no recorte"
      : secondary.customersWithService
        ? `${Math.round((secondary.lapsedCustomers / secondary.customersWithService) * 100)}% dos ${secondary.customersWithService} clientes com serviço`
        : undefined;

  return (
    <>
      <PageSection title="Indicadores principais">
        <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
          {previous ? (
            <>
              Os deltas comparam com <strong>{formatPeriodProse(previous.start, previous.end)}</strong> — o
              período imediatamente anterior, do mesmo tamanho e sob os mesmos filtros. Sem período anterior,
              ou com valor anterior zero, o card fica sem chip em vez de mostrar 0%.
            </>
          ) : (
            <>
              Início ou Fim está em aberto, então os deltas não comparam com um período anterior.
            </>
          )}
        </Typography>
        <CardGrid columns={4}>
          <KpiCard
            label="Total de Leads"
            value={String(insights.primary.leads.value ?? 0)}
            kpi={insights.primary.leads}
            detail={
              <DetailBlock label="Por período">
                <Table size="small" aria-label="Conversas por período">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={METRIC_LABEL_SX}>{GRANULARITY_LABEL[granularity]}</TableCell>
                      <TableCell sx={METRIC_LABEL_SX} align="right">
                        Novas
                      </TableCell>
                      <TableCell sx={METRIC_LABEL_SX} align="right">
                        Ativas
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.buckets.map((bucket) => (
                      <TableRow key={bucket.bucketStart}>
                        <TableCell>{formatBucketDay(bucket.bucketStart)}</TableCell>
                        <TableCell align="right">{bucket.newConversationCount}</TableCell>
                        <TableCell align="right">{bucket.activeConversationCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </DetailBlock>
            }
          />
          {/* The absent cases of this band, each naming its OWN base, on the
              same rule the Atendimento e clientes band follows. A rate has no
              value when its denominator is empty, and the denominator differs
              per card: Conversão divides by the novas linked to a customer,
              Tempo Médio by the novas that got a first reply. */}
          <KpiCard
            label="Taxa de Conversão"
            value={formatPercent(insights.primary.conversionRate.value)}
            kpi={insights.primary.conversionRate}
            note={
              insights.primary.conversionRate.value == null
                ? "nenhuma conversa vinculada a cliente no recorte"
                : undefined
            }
            detail={attributionDetail}
          />
          {/* Revenue is coerced rather than captioned, the way Total de Leads
              is. Nothing attributed is zero reais, a known figure — the API
              sums into a counter that starts at zero and `emptyReportInsights`
              reports zero — so the contract's nullable value has no absent
              MEANING to explain. A caption here would invent a reason for a
              state that never carries one. */}
          <KpiCard
            label="Receita Gerada"
            value={formatMoney(insights.primary.revenue.value ?? 0)}
            kpi={insights.primary.revenue}
            detail={attributionDetail}
          />
          <KpiCard
            label="Tempo Médio de Resposta"
            value={formatDuration(insights.primary.meanFirstResponseMs.value)}
            kpi={insights.primary.meanFirstResponseMs}
            lowerIsBetter
            note={
              insights.primary.meanFirstResponseMs.value == null
                ? "nenhuma conversa respondida no recorte"
                : undefined
            }
            foot={coverageLine}
            detail={
              <>
                {/* No mean here: the card's own value IS the first-response
                    mean, and the screen prints it exactly once. */}
                <DetailBlock label="Primeira resposta">
                  <StatLine
                    stats={[
                      { value: formatDuration(data.firstResponse.medianMs), caption: "mediana" },
                      { value: formatDuration(data.firstResponse.p90Ms), caption: "p90" },
                    ]}
                  />
                </DetailBlock>
                <DetailBlock label="Ao longo da conversa">
                  <StatLine
                    stats={[
                      { value: formatDuration(data.subsequentResponse.meanMs), caption: "média" },
                      { value: formatDuration(data.subsequentResponse.medianMs), caption: "mediana" },
                      { value: formatDuration(data.subsequentResponse.p90Ms), caption: "p90" },
                    ]}
                  />
                </DetailBlock>
              </>
            }
          />
        </CardGrid>
      </PageSection>

      <FunnelSection funnel={insights.funnel} periodFrom={periodFrom} periodTo={periodTo} />
      <OriginSection
        rows={insights.originRows}
        campaigns={data.byCampaign}
        periodFrom={periodFrom}
        periodTo={periodTo}
      />

      <PageSection title="Atendimento e clientes">
        <CardGrid columns={4}>
          {/* Orçamentos sem resposta is deliberately NOT a card here: it is a
              present-moment pendency, the alert strip already shows it, and the
              strip — unlike a card — navigates to where the pendency is worked.
              "no período" earns its length: the strip says "mensagens aguardando
              resposta" and means THIS moment. */}
          <SummaryCard
            label="Conversas sem resposta no período"
            value={String(secondary.unanswered)}
            note={waitMean === null ? undefined : `espera média ${formatDuration(waitMean)}`}
          />
          <SummaryCard
            label="Taxa de Aprovação"
            value={formatPercent(secondary.approvalRate)}
            note={secondary.approvalRate == null ? "nenhum orçamento enviado no recorte" : undefined}
          />
          {/* Renamed with their meaning, not for style: filtered by a month,
              "LTV" would state average revenue in that month, and "churn" would
              count who fell due in the period rather than the standing state of
              the base. The count is the headline; the rate is its caption. */}
          <SummaryCard
            label="Clientes perdidos no período"
            value={secondary.lapsedCustomers == null ? "—" : String(secondary.lapsedCustomers)}
            note={lapsedCaption}
          />
          <SummaryCard
            label="Receita média por cliente"
            value={formatMoney(secondary.ltv)}
            note={
              secondary.customersServedInPeriod == null
                ? "nenhum cliente atendido no recorte"
                : `entre os ${secondary.customersServedInPeriod} clientes com serviço`
            }
          />
        </CardGrid>
      </PageSection>

      <TagsSection byTag={data.byTag} scheduled={data.scheduled} />
    </>
  );
}

/**
 * Tinted Follow-up chips; each chip navigates to `/follow-up`.
 *
 * Drawn OUTSIDE every state of the report query, and above the filter bar. Its
 * position is what says it is not part of the selected cut, and being above
 * means nothing below has to disclaim that it is. It reads the Follow-up counts
 * contract — a different request, which has not failed just because the report
 * did, so a failed report must not take the pending queue off the screen.
 *
 * Each count is optional on the wire. A chip is drawn only for a count that
 * arrived, because "0 retornos vencidos" is a claim and `undefined` is not that
 * claim. Unlike the navigation badge, which sums the four and therefore cannot
 * survive a partial answer, these chips are independent: two known counts are
 * two true statements, and the third being absent does not make them false.
 *
 * @param counts - Follow-up list lengths after the cap, or undefined when the
 *   counts read has not resolved or failed.
 * @param failed - True when the counts read errored, which is said in
 *   Portuguese rather than drawn as zeros.
 */
function FollowUpAlertStrip({
  counts,
  failed,
}: {
  counts?: FollowUpOptionalCounts;
  failed: boolean;
}) {
  const chips: string[] = [];
  if (counts?.overdueReturns !== undefined) {
    chips.push(`${counts.overdueReturns} retornos vencidos`);
  }
  if (counts?.unansweredQuotes !== undefined) {
    chips.push(`${counts.unansweredQuotes} orçamentos sem resposta`);
  }
  if (counts?.waitingReply !== undefined) {
    chips.push(`${counts.waitingReply} mensagens aguardando resposta`);
  }
  // In-flight is not a missing strip and not a load failure. A 200 that
  // omitted the three chip fields still renders the band: the spec requires
  // the strip in every report state, and "no chip keys" is not "unavailable".
  if (!failed && counts === undefined) {
    return null;
  }
  return (
    <Stack
      component="section"
      aria-label="Alertas de follow-up"
      direction="row"
      spacing={1}
      useFlexGap
      sx={{
        flexWrap: "wrap",
        alignItems: "center",
        px: 2,
        py: 1.5,
        borderRadius: 1,
        bgcolor: "primaryContainer",
        color: "onPrimaryContainer",
      }}
    >
      {failed ? (
        <Typography sx={{ fontSize: TYPE_SCALE.body }}>
          Não foi possível carregar os alertas de follow-up.
        </Typography>
      ) : chips.length === 0 ? (
        <Typography sx={{ fontSize: TYPE_SCALE.caption, opacity: 0.8 }}>
          deste momento · não muda com os filtros abaixo
        </Typography>
      ) : (
        <>
          {chips.map((label) => (
            <Chip
              key={label}
              component={RouterLink}
              to="/follow-up"
              clickable
              label={label}
              sx={{
                bgcolor: "background.paper",
                color: "onSecondaryContainer",
                fontWeight: 600,
                borderRadius: 2,
                // These chips are links, so their boundary is subject to WCAG
                // 2.2 non-text contrast (1.4.11, 3:1), and a white fill on a
                // `primaryContainer` band does not carry one: white reaches
                // only 1.11:1 on yellow-cta's cream band and 1.87:1 on
                // black-cta's gold one. The artboard draws the pills borderless
                // and inherits the same weakness, so the hairline is a
                // deliberate departure from it. `divider` cannot serve — it is
                // tuned for hairlines on white and manages 1.27:1 on the band —
                // so the outline reuses the ink the label is already drawn in,
                // which reads as one pill rather than two tokens and follows
                // the palette on its own: 11.86:1 on yellow-cta and 7.07:1 on
                // black-cta. The band itself is untouched; it stays the ambient
                // alert strip the artboard draws, and the pills gain the edge
                // they were missing.
                border: 1,
                borderColor: "onSecondaryContainer",
              }}
            />
          ))}
          <Typography sx={{ fontSize: TYPE_SCALE.caption, opacity: 0.8 }}>
            deste momento · não muda com os filtros abaixo
          </Typography>
        </>
      )}
    </Stack>
  );
}

/** Four (or two) equal columns of cards, the artboard's card row. */
function CardGrid({ columns, children }: { columns: 2 | 4; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: `repeat(${columns}, minmax(0, 1fr))` },
        gap: 2,
        // The artboard draws a row of cards as one band: every card in the row
        // reaches the height of the tallest, so their bottom hairlines line up.
        // `start` sized each card to its own content, which staggered them
        // whenever one card carried a caption or a delta chip the others did
        // not. The cards are already flex columns, so stretching only grows
        // the box; it does not stretch the content inside it.
        alignItems: "stretch",
      }}
    >
      {children}
    </Box>
  );
}

/** A labelled block inside a mark's detail: the artboard's `.detail-label` over its content. */
function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Typography component="span" sx={METRIC_LABEL_SX}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

/** "48s mediana · 4m p90": value over caption, side by side. */
function StatLine({ stats }: { stats: { value: string; caption: string }[] }) {
  return (
    <Stack direction="row" spacing={3} useFlexGap>
      {stats.map((stat) => (
        <Box key={stat.caption}>
          <Typography sx={{ fontSize: TYPE_SCALE.subsection, fontWeight: 600 }}>{stat.value}</Typography>
          <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
            {stat.caption}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * Primary KPI tile: upper-cased caption label with the mark at the row's end, a
 * big value, an optional signed-percent delta chip, an optional foot line under a
 * hairline (Tempo Médio's Cobertura), and the mark's explanation plus detail.
 *
 * @param label - Visible metric name and the explanation's lookup key.
 * @param value - Already formatted value (or em dash).
 * @param kpi - Raw KPI including optional `deltaPct`.
 * @param lowerIsBetter - When true (Tempo Médio), a falling delta is green.
 * @param note - Caption under the value, with no hairline: why this card's
 *   value is absent, named in terms of that card's own base.
 * @param foot - Caption drawn last, under a hairline; omitted when undefined.
 * @param detail - What the mark reveals under the explanation.
 */
function KpiCard({
  label,
  value,
  kpi,
  lowerIsBetter = false,
  note,
  foot,
  detail,
}: {
  label: string;
  value: string;
  kpi: ReportKpi;
  lowerIsBetter?: boolean;
  note?: string;
  foot?: string;
  detail?: ReactNode;
}) {
  // A delta of exactly zero is neither an improvement nor a regression: it gets a
  // neutral chip, because an absent chip would read as "no prior period" (the
  // basis line above the row says so) and a red one would read as a regression.
  const improved =
    kpi.deltaPct == null || kpi.deltaPct === 0
      ? null
      : lowerIsBetter
        ? kpi.deltaPct < 0
        : kpi.deltaPct > 0;
  const why = useMetricWhy(label, detail);
  return (
    <Box sx={{ ...cardSx, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography component="span" sx={METRIC_LABEL_SX}>
          {label}
        </Typography>
        {why.mark}
      </Stack>
      <Typography
        data-testid="metric-value"
        sx={{ fontSize: TYPE_SCALE.metric, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}
      >
        {value}
      </Typography>
      {kpi.deltaPct != null ? (
        <Chip
          size="small"
          label={formatDelta(kpi.deltaPct)}
          sx={{
            alignSelf: "flex-start",
            fontWeight: 700,
            // The artboard draws the delta as a soft tint, not MUI's
            // full-strength success/error fill, so the chip paints itself
            // from the status container tokens. The zero delta keeps the
            // default grey chip: neutral is the absence of a tint, not a
            // third colour.
            ...(improved == null
              ? {}
              : improved
                ? { bgcolor: "successContainer", color: "onSuccessContainer" }
                : { bgcolor: "errorContainer", color: "onErrorContainer" }),
          }}
        />
      ) : null}
      {/* Same caption treatment as the Atendimento e clientes band, and
          deliberately NOT `foot`: `foot` draws a hairline above itself, which
          is the Cobertura line's look, and an absence reason is not a
          footnote. A card can carry both — a cut with novas where none was
          answered has no mean to print AND a coverage of 0%. */}
      {note ? (
        <Typography
          data-testid="metric-note"
          sx={{ fontSize: TYPE_SCALE.caption }}
          color="text.secondary"
        >
          {note}
        </Typography>
      ) : null}
      {why.body}
      {foot ? (
        <Typography
          component="p"
          sx={{ fontSize: TYPE_SCALE.caption, mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}
          color="text.secondary"
        >
          {foot}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * Funil de Vendas: four nested-subset stages, each after the first showing
 * what share of the PRECEDING stage it retained, plus the sentence naming the
 * biggest drop. The section mark explains the funnel in a card above it.
 *
 * @param funnel - The four stage counts from the report's insights.
 * @param periodFrom - The report's own period start, carried onto every
 *   stage's drill-through link.
 * @param periodTo - The report's own period end.
 */
function FunnelSection({
  funnel,
  periodFrom,
  periodTo,
}: {
  funnel: ReportResult["insights"]["funnel"];
  periodFrom: string;
  periodTo: string;
}) {
  const why = useMetricWhy("Funil de Vendas");
  const stages: { key: ConversationPipelineStage; value: number }[] = [
    { key: "novosContatos", value: funnel.novosContatos },
    { key: "emAtendimento", value: funnel.emAtendimento },
    { key: "orcamentoEnviado", value: funnel.orcamentoEnviado },
    { key: "servicosFeitos", value: funnel.servicosFeitos },
  ];
  // Retention is a share of the stage BEFORE it, not of the funnel's first
  // stage — that is what makes the step where it collapses legible, rather
  // than only the cumulative drop from the top.
  const retention = stages.map((stage, index) => {
    const previous = index > 0 ? stages[index - 1]!.value : null;
    return previous !== null && previous > 0 ? stage.value / previous : null;
  });
  const known = retention.filter((r): r is number => r !== null);
  const weakest = known.length > 0 ? Math.min(...known) : null;
  const weakestIndex = weakest === null ? -1 : retention.indexOf(weakest);
  return (
    <PageSection title="Funil de Vendas" end={why.mark}>
      {why.open ? <Box sx={cardSx}>{why.content}</Box> : null}
      <Box sx={cardSx}>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0.5 }}>
          {stages.map((stage, index) => (
            <Box
              key={stage.key}
              component={RouterLink}
              to={inboxDrillLink({ stage: stage.key, from: periodFrom, to: periodTo })}
              aria-label={`Conversas da etapa ${FUNNEL_STAGE_LABELS[stage.key]}`}
              sx={{ minWidth: 0, textDecoration: "none", color: "inherit", display: "block" }}
            >
              <Box
                sx={(t) => {
                  // The artboard fades the gold one step per stage. `opacity`
                  // faded the whole chevron, the stage count with it, so the
                  // number lost contrast exactly where the funnel narrows.
                  // funnelStage puts the step in the FILL and measures a label
                  // against it, so every stage stays readable on both palettes;
                  // both colours come from the theme, so no hex reaches here.
                  const fade = funnelStage(t.palette, index);
                  return {
                    height: 44,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: fade.fill,
                    color: fade.label,
                    fontSize: TYPE_SCALE.subsection,
                    fontWeight: 800,
                    clipPath:
                      index === 0
                        ? "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%)"
                        : "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%)",
                  };
                }}
              >
                {stage.value}
              </Box>
              <Typography sx={{ fontSize: TYPE_SCALE.caption, mt: 1 }} color="text.secondary">
                {FUNNEL_STAGE_LABELS[stage.key]}
              </Typography>
              <Typography sx={{ ...GO_SX, mt: 0.5 }}>{`ver as ${stage.value}`}</Typography>
            </Box>
          ))}
        </Box>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0.5, mt: 1 }}>
          {retention.map((ratio, index) => (
            <Typography
              key={stages[index]!.key}
              sx={{
                textAlign: "center",
                fontSize: TYPE_SCALE.caption,
                fontWeight: 700,
                color: index === weakestIndex ? "error.main" : "text.secondary",
              }}
            >
              {ratio === null ? "" : `${formatRetention(ratio)} seguem`}
            </Typography>
          ))}
        </Box>
        {weakestIndex > 0 ? (
          <Typography sx={{ fontSize: TYPE_SCALE.caption, mt: 1 }} color="text.secondary">
            {dropSentence(stages[weakestIndex - 1]!, stages[weakestIndex]!)}
          </Typography>
        ) : null}
      </Box>
    </PageSection>
  );
}

/**
 * "A maior queda é de Em atendimento para Orçamento Enviado: de 80 conversas
 * atendidas, 30 receberam orçamento." — the artboard's stem with a clause
 * specific to the pair, so each step reads in its own words.
 */
function dropSentence(
  from: { key: ConversationPipelineStage; value: number },
  to: { key: ConversationPipelineStage; value: number },
) {
  const clause: Record<Exclude<ConversationPipelineStage, "novosContatos">, string> = {
    emAtendimento: `de ${from.value} novos contatos, ${to.value} foram atendidas`,
    orcamentoEnviado: `de ${from.value} conversas atendidas, ${to.value} receberam orçamento`,
    servicosFeitos: `de ${from.value} orçamentos enviados, ${to.value} viraram serviço`,
  };
  const key = to.key as Exclude<ConversationPipelineStage, "novosContatos">;
  return `A maior queda é de ${FUNNEL_STAGE_LABELS[from.key]} para ${FUNNEL_STAGE_LABELS[to.key]}: ${clause[key]}.`;
}

/**
 * Share of the period's leads a row must carry before it can be tinted.
 *
 * A rate computed on a handful of leads is not a finding. Without a floor the
 * tint lands on whichever origin got lucky: a row with one lead and one
 * conversion scores 100% and beats a row carrying twenty-four of the period's
 * twenty-six leads, which is what the shipped screen did. Ten percent is the
 * lowest floor that fixes it without narrowing the approved design — every row
 * of the artboard's own table stays eligible, its smallest sitting exactly on
 * the boundary at ten of a hundred leads, while both one-lead rows of the
 * shipped capture fall out.
 */
const HIGHLIGHT_MIN_LEAD_SHARE = 0.1;

/**
 * The origin whose row is tinted, or null when no row earns it.
 *
 * Highest conversion rate among rows that clear
 * {@link HIGHLIGHT_MIN_LEAD_SHARE}. A tie on that rate is broken by lead
 * volume, so the tint lands on the better-evidenced of two equal rates; a tie
 * on rate AND volume is left untinted, because a mark on two rows singles out
 * neither. Rows that converted nothing are never eligible, so an all-zero
 * table tints nothing rather than tinting its first row.
 *
 * @param rows - Origin KPIs from the report, in display order.
 * @returns The winning row's origin, or null when the table earns no tint.
 */
function highlightedOrigin(rows: ReportResult["insights"]["originRows"]) {
  const totalLeads = rows.reduce((sum, row) => sum + row.leads, 0);
  if (totalLeads === 0) {
    return null;
  }
  const eligible = rows.flatMap((row) =>
    row.conversionRate != null &&
    row.conversionRate > 0 &&
    row.leads / totalLeads >= HIGHLIGHT_MIN_LEAD_SHARE
      ? [{ origin: row.origin, rate: row.conversionRate, leads: row.leads }]
      : [],
  );
  if (eligible.length === 0) {
    return null;
  }
  const topRate = Math.max(...eligible.map((row) => row.rate));
  const atTopRate = eligible.filter((row) => row.rate === topRate);
  const topLeads = Math.max(...atTopRate.map((row) => row.leads));
  const winners = atTopRate.filter((row) => row.leads === topLeads);
  return winners.length === 1 ? winners[0]!.origin : null;
}

/**
 * Exactly three origin rows: anúncio, orgânica, desconhecida, each a link into
 * the inbox with a trailing `ver as N →` cell. The section mark explains the
 * table and lists the campaign breakdown, in a card above it.
 *
 * @param rows - Origin KPIs from the report.
 * @param campaigns - The period's campaign rows, drawn behind the section mark.
 * @param periodFrom - The report's own period, carried onto every row's drill-through link.
 * @param periodTo - The report's own period end.
 */
function OriginSection({
  rows,
  campaigns,
  periodFrom,
  periodTo,
}: {
  rows: ReportResult["insights"]["originRows"];
  campaigns: ReportResult["byCampaign"];
  periodFrom: string;
  periodTo: string;
}) {
  const navigate = useNavigate();
  const highlighted = highlightedOrigin(rows);
  const why = useMetricWhy(
    "Tabela de Origem",
    <DetailBlock label="Por campanha ou anúncio">
      {campaigns.length === 0 ? (
        <Typography sx={{ fontSize: TYPE_SCALE.body }} color="text.secondary">
          Nenhuma campanha ou anúncio identificado no período.
        </Typography>
      ) : (
        <Table size="small" aria-label="Conversas por campanha/anúncio">
          <TableBody>
            {campaigns.map((row) => (
              <TableRow key={`${row.campaignId}:${row.adSetId ?? ""}:${row.adId ?? ""}`}>
                <TableCell>{campaignRowLabel(row)}</TableCell>
                <TableCell align="right">{row.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DetailBlock>,
  );
  return (
    <PageSection title="Tabela de Origem" end={why.mark}>
      {/* The tint's legend. A colour with no legend does not say what it means
          to anyone, which is how the highlight reached design evaluation as a
          question rather than as a finding — the artboard cannot disambiguate
          it either, because the row it tints is both the filter's match and the
          best-converting one. It names the exclusion as well as the rule: a
          reader told only the first half would wonder why their 100% row is
          not tinted. It is a section note, never a cue inside the row. */}
      <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
        A linha destacada é a origem com maior taxa de conversão. Origens com menos de 10% dos leads
        do período ficam de fora.
      </Typography>
      {why.open ? <Box sx={cardSx}>{why.content}</Box> : null}
      <Box sx={cardSx}>
        <Table size="small" aria-label="Tabela de Origem">
          <TableHead>
            <TableRow>
              <TableCell sx={METRIC_LABEL_SX}>Origem</TableCell>
              <TableCell sx={METRIC_LABEL_SX} align="right">
                Leads
              </TableCell>
              <TableCell sx={METRIC_LABEL_SX} align="right">
                Conversão
              </TableCell>
              <TableCell sx={METRIC_LABEL_SX} align="right">
                Receita
              </TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const notable = row.origin === highlighted;
              const href = inboxDrillLink({ origin: row.origin, from: periodFrom, to: periodTo });
              return (
                <TableRow
                  key={row.origin}
                  hover
                  tabIndex={0}
                  role="link"
                  aria-label={`Conversas de origem ${SOURCE_TYPE_LABEL[row.origin]}`}
                  onClick={() => navigate(href)}
                  onKeyDown={(event) => {
                    // A tr cannot legally contain an <a> wrapping its <td>s, so
                    // the row behaves as a link via role + keyboard handling
                    // rather than an actual anchor.
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigate(href);
                    }
                  }}
                  sx={{
                    cursor: "pointer",
                    "&:last-child td": { borderBottom: 0 },
                    ...(notable ? { bgcolor: "primaryContainer" } : undefined),
                  }}
                >
                  <TableCell>{SOURCE_TYPE_LABEL[row.origin]}</TableCell>
                  <TableCell align="right">{row.leads}</TableCell>
                  <TableCell align="right">
                    {row.conversionRate == null
                      ? "—"
                      : `${row.conversions} (${Math.round(row.conversionRate * 100)}%)`}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                    {formatMoney(row.revenue)}
                  </TableCell>
                  <TableCell align="right" sx={GO_SX}>{`ver as ${row.leads} →`}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
    </PageSection>
  );
}

/**
 * Tags e mensagens programadas: the two figures that explain no metric above,
 * as two cards of label–count rows. Two cards whenever at least one has rows
 * (the empty one states its absence); when both are empty the section keeps
 * one stated absence and no card — a stated absence is true, where a row of
 * zeros would not be.
 */
function TagsSection({
  byTag,
  scheduled,
}: {
  byTag: ReportResult["byTag"];
  scheduled: ReportResult["scheduled"];
}) {
  const hasScheduled = scheduledHasRows(scheduled);
  return (
    <PageSection title="Tags e mensagens programadas">
      {byTag.length === 0 && !hasScheduled ? (
        <Typography sx={{ fontSize: TYPE_SCALE.body }} color="text.secondary">
          Nenhuma tag nem mensagem programada no período.
        </Typography>
      ) : (
        <CardGrid columns={2}>
          <CountCard
            heading="Conversas por tag"
            ariaLabel="Conversas por tag"
            empty="Nenhuma conversa com tag no período."
            rows={byTag.map((row) => ({ key: row.tagId, name: row.name, count: row.count }))}
          />
          <CountCard
            heading="Mensagens programadas por situação"
            ariaLabel="Mensagens programadas"
            empty="Nenhuma mensagem programada no período."
            rows={
              hasScheduled
                ? [
                    { key: "scheduled", name: "Programadas", count: scheduled.scheduled },
                    { key: "sent", name: "Enviadas", count: scheduled.sent },
                    { key: "cancelled", name: "Canceladas", count: scheduled.cancelled },
                    { key: "failed", name: "Com falha", count: scheduled.failed },
                  ]
                : []
            }
          />
        </CardGrid>
      )}
    </PageSection>
  );
}

/**
 * Compact metric tile in the Atendimento e clientes row: upper-cased label with
 * its mark, a big value, and one caption under it.
 * @param label - Metric title and the explanation's lookup key.
 * @param value - Preformatted metric string from the report DTO.
 * @param note - Caption under the value (mean wait, absence reason, the rate's base).
 */
function SummaryCard({ label, value, note }: { label: string; value: string; note?: string }) {
  const why = useMetricWhy(label);
  return (
    <Box sx={{ ...cardSx, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography component="span" sx={METRIC_LABEL_SX}>
          {label}
        </Typography>
        {why.mark}
      </Stack>
      <Typography
        data-testid="metric-value"
        sx={{ fontSize: TYPE_SCALE.metric, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}
      >
        {value}
      </Typography>
      {note ? (
        <Typography
          data-testid="metric-note"
          sx={{ fontSize: TYPE_SCALE.caption }}
          color="text.secondary"
        >
          {note}
        </Typography>
      ) : null}
      {why.body}
    </Box>
  );
}

/**
 * Label–count rows under an upper-cased heading (tag rows, scheduled-status rows).
 * @param heading - Visible card title.
 * @param ariaLabel - Accessible name of the table.
 * @param empty - Portuguese absence line drawn when there are no rows.
 * @param rows - Label/count pairs.
 */
function CountCard({
  heading,
  ariaLabel,
  empty,
  rows,
}: {
  heading: string;
  ariaLabel: string;
  empty: string;
  rows: { key: string; name: string; count: number }[];
}) {
  return (
    <Box sx={{ ...cardSx, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography component="span" sx={METRIC_LABEL_SX}>
        {heading}
      </Typography>
      {rows.length === 0 ? (
        <Typography sx={{ fontSize: TYPE_SCALE.body }} color="text.secondary">
          {empty}
        </Typography>
      ) : (
        <Table size="small" aria-label={ariaLabel}>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} sx={{ "&:last-child td": { borderBottom: 0 } }}>
                <TableCell sx={{ px: 0 }}>{row.name}</TableCell>
                <TableCell align="right" sx={{ px: 0 }}>
                  {row.count}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
