/**
 * Unit-wide Serviços screen — the store's OS ledger, as a list beside a detail.
 *
 * Read-only by design: the Omie is the sole creator of service fields, so this
 * screen offers no control that creates or edits one.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import type {
  Service,
  UnitServiceQuery,
  UnitServiceRow,
} from "@select-lub/shared-types";
import { fetchServiceDetail, fetchUnitServices } from "./api.js";
import { ScreenNav } from "./ScreenNav.js";
import { UI_VARIANT } from "./uiVariant.js";
import { MAIN_CONTENT_ID, shellBelowBarSx, TYPE_SCALE } from "./theme.js";

function formatDate(iso: string | null) {
  if (!iso) {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function formatAmount(amount: number | null) {
  if (amount == null) {
    return "";
  }
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    amount,
  );
}

function formatKm(km: number | null) {
  return km == null ? "" : `${new Intl.NumberFormat("pt-BR").format(km)} km`;
}

function vehicleLabel(row: {
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
}) {
  return [
    row.vehicleMake,
    row.vehicleModel,
    row.vehicleYear == null ? null : String(row.vehicleYear),
  ]
    .filter((part): part is string => part != null && part.trim() !== "")
    .join(" ");
}

/** Products and oil from the service's line items, which the old screen dropped. */
function productsLabel(
  items: {
    description: string;
    oilBrand: string | null;
    oilViscosity: string | null;
  }[],
) {
  if (items.length === 0) {
    return "Sem produtos lançados";
  }
  return items
    .map((item) =>
      [item.oilBrand, item.oilViscosity].some(Boolean)
        ? [item.oilBrand, item.oilViscosity].filter(Boolean).join(" ")
        : item.description,
    )
    .join(" · ");
}

function StatusChip({ status }: { status: string | null }) {
  if (!status) {
    return null;
  }
  return <Chip size="small" label={status} sx={{ fontSize: TYPE_SCALE.caption }} />;
}

/** One row in the left list. Marks an unlinked vehicle rather than hiding the service. */
function ServiceRow({
  row,
  selected,
  onSelect,
}: {
  row: UnitServiceRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const vehicle = vehicleLabel(row);
  return (
    <Box
      component="button"
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      sx={{
        width: "100%",
        textAlign: "left",
        border: 0,
        borderBottom: 1,
        borderColor: "divider",
        borderLeft: 3,
        borderLeftColor: selected ? "primary.main" : "transparent",
        bgcolor: selected ? "primary.container" : "transparent",
        px: 2,
        py: 1.5,
        cursor: "pointer",
        font: "inherit",
        display: "block",
      }}
    >
      <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary" }}>
          {formatDate(row.performedAt)}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 600 }}>
          {formatAmount(row.amount)}
        </Typography>
      </Stack>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 0.5 }}>
        <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 600 }}>
          {row.customerName}
        </Typography>
        <StatusChip status={row.status} />
      </Stack>
      <Typography
        sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary", mt: 0.5 }}
      >
        {vehicle === "" ? (
          <Box component="span" sx={{ fontStyle: "italic" }}>
            Sem veículo vinculado
          </Box>
        ) : (
          `${vehicle}${row.vehiclePlate ? ` · ${row.vehiclePlate}` : ""}`
        )}
        {row.description || row.kind ? ` · ${row.description ?? row.kind}` : ""}
      </Typography>
      <Typography
        sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary", mt: 0.5 }}
      >
        {[
          formatKm(row.odometerKm),
          productsLabel(row.items),
          row.omieId ? `OS ${row.omieId}` : row.origin,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Typography>
    </Box>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" sx={{ gap: 1, alignItems: "baseline" }}>
      <Typography
        sx={{
          fontSize: TYPE_SCALE.caption,
          color: "text.secondary",
          width: 120,
          flexShrink: 0,
        }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontSize: 12, flex: 1 }}>{value}</Typography>
    </Stack>
  );
}

/** The right pane: one service in full, always visible beside the list. */
function ServiceDetailPane({ serviceId }: { serviceId: string }) {
  const detail = useQuery({
    queryKey: ["service-detail", serviceId],
    queryFn: () => fetchServiceDetail(serviceId),
  });

  if (detail.isLoading) {
    return (
      <Stack spacing={1} sx={{ p: 3 }} role="status">
        <Skeleton variant="rounded" height={28} width={280} />
        <Skeleton variant="rounded" height={120} />
        <Typography sx={{ fontSize: TYPE_SCALE.body }}>Carregando serviço</Typography>
      </Stack>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Stack spacing={1} sx={{ p: 3, alignItems: "flex-start" }}>
        <Alert severity="error">Não foi possível carregar o serviço</Alert>
        <Button variant="contained" onClick={() => void detail.refetch()}>
          Tentar de novo
        </Button>
      </Stack>
    );
  }

  const row = detail.data;
  const vehicle = vehicleLabel(row);
  const origin = row.omieId ? `Omie · OS ${row.omieId}` : row.origin;
  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 3 }}>
        <Stack direction="row" sx={{ gap: 3, alignItems: "flex-start" }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography component="h2" sx={{ fontSize: 18, fontWeight: 700 }}>
              {[formatDate(row.performedAt), row.description ?? row.kind]
                .filter(Boolean)
                .join(" · ")}
            </Typography>
            <Typography
              sx={{ fontSize: TYPE_SCALE.body, color: "text.secondary", mt: 0.5 }}
            >
              {[
                row.customerName,
                vehicle === "" ? "Sem veículo vinculado" : vehicle,
                row.vehiclePlate,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <StatusChip status={row.status} />
              <Chip size="small" label={origin} sx={{ fontSize: TYPE_SCALE.caption }} />
            </Stack>
          </Box>
          <Typography sx={{ fontSize: TYPE_SCALE.metric, fontWeight: 800 }}>
            {formatAmount(row.amount)}
          </Typography>
        </Stack>

        <Stack
          direction="row"
          sx={{ gap: 3, mt: 3, alignItems: "flex-start", flexWrap: "wrap" }}
        >
          <Stack spacing={2} sx={{ flex: 1, minWidth: 320, maxWidth: 660 }}>
            <Box>
              <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700, mb: 1 }}>
                Detalhes
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={0.75}>
                  <KeyValue label="Cliente" value={row.customerName} />
                  <KeyValue
                    label="Veículo"
                    value={vehicle === "" ? "Sem veículo vinculado" : vehicle}
                  />
                  <KeyValue
                    label="Quilometragem"
                    value={formatKm(row.odometerKm) || "Não informada"}
                  />
                  <KeyValue label="Situação" value={row.status ?? "Não informada"} />
                  <KeyValue label="Origem" value={origin} />
                </Stack>
              </Paper>
            </Box>

            <Box>
              <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700, mb: 1 }}>
                Itens
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                {row.items.length === 0 ? (
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                    Nenhum item lançado nesta OS
                  </Typography>
                ) : (
                  <Stack spacing={0.75}>
                    {row.items.map((item) => (
                      <Stack
                        key={item.id}
                        direction="row"
                        sx={{ gap: 1, alignItems: "baseline" }}
                      >
                        <Typography sx={{ fontSize: 12, flex: 1 }}>
                          {item.description}
                        </Typography>
                        <Typography
                          sx={{
                            fontSize: 12,
                            color: "text.secondary",
                            width: 48,
                            textAlign: "right",
                          }}
                        >
                          {item.quantity == null ? "" : `${item.quantity} ×`}
                        </Typography>
                        <Typography
                          sx={{
                            fontSize: 12,
                            fontWeight: 600,
                            width: 96,
                            textAlign: "right",
                          }}
                        >
                          {formatAmount(item.lineAmount)}
                        </Typography>
                      </Stack>
                    ))}
                    <Divider />
                    <Stack direction="row" sx={{ gap: 1, alignItems: "baseline" }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 600, flex: 1 }}>
                        Total
                      </Typography>
                      <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
                        {formatAmount(row.amount)}
                      </Typography>
                    </Stack>
                  </Stack>
                )}
              </Paper>
            </Box>

            <Box>
              <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700, mb: 1 }}>
                Orçamento de origem
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                {row.attributedQuote === null ? (
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                    Nenhum orçamento atribuído a este serviço
                  </Typography>
                ) : (
                  <Stack spacing={0.5}>
                    <Typography sx={{ fontSize: 12 }}>
                      Orçamento enviado em {formatDate(row.attributedQuote.sentAt)}
                    </Typography>
                    <Typography
                      sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary" }}
                    >
                      Atribuído a este serviço pela regra versão{" "}
                      {row.attributedQuote.ruleVersion}
                    </Typography>
                  </Stack>
                )}
              </Paper>
            </Box>
          </Stack>

          <Box sx={{ width: 300 }}>
            <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700, mb: 1 }}>
              Histórico do veículo
            </Typography>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              {row.vehicleHistory.length === 0 ? (
                <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                  {row.vehicleId === null
                    ? "Sem veículo vinculado — histórico indisponível"
                    : "Primeiro serviço registrado para este veículo"}
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {row.vehicleHistory.map((past: Service) => (
                    <Box key={past.id}>
                      <Stack direction="row" sx={{ gap: 1, alignItems: "baseline" }}>
                        <Typography sx={{ fontSize: 12, flex: 1 }}>
                          {formatDate(past.performedAt)}
                        </Typography>
                        <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
                          {formatAmount(past.amount)}
                        </Typography>
                      </Stack>
                      <Typography
                        sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary" }}
                      >
                        {[past.description ?? past.kind, formatKm(past.odometerKm)]
                          .filter(Boolean)
                          .join(" · ")}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </Paper>
          </Box>
        </Stack>
      </Box>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          p: 1.5,
          px: 3,
          borderTop: 1,
          borderColor: "divider",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <Button size="small" variant="outlined" component={RouterLink} to="/">
          Abrir conversa
        </Button>
        <Button size="small" variant="outlined" component={RouterLink} to="/">
          Programar mensagem
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: TYPE_SCALE.caption, color: "text.secondary" }}>
          Somente leitura — a OS é mantida no Omie
        </Typography>
      </Stack>
    </Stack>
  );
}

/**
 * Standalone Serviços listing at `/servicos`: a filtered, paged list beside the
 * selected service in full.
 *
 * @returns Loading, empty, no-match, error, or a list-and-detail view of `GET /services`.
 */
export function ServicosPage() {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // "Todas" is the UI's own default, not a wire value: the filter is either
  // absent from the query (every service) or one of the two return states.
  const [returnState, setReturnState] = useState<
    "TODAS" | NonNullable<UnitServiceQuery["returnState"]>
  >("TODAS");
  const [picked, setPicked] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      ...(search.trim() === "" ? {} : { search: search.trim() }),
      ...(from === "" ? {} : { from }),
      ...(to === "" ? {} : { to }),
      ...(returnState === "TODAS" ? {} : { returnState }),
    }),
    [search, from, to, returnState],
  );
  const filtered = Object.keys(filters).length > 0;

  const list = useInfiniteQuery({
    queryKey: ["unit-services", filters],
    queryFn: ({ pageParam }) =>
      fetchUnitServices({
        ...filters,
        ...(pageParam ? { cursor: pageParam as string } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.rows),
    [list.data],
  );
  const totals = list.data?.pages[0];
  const selected =
    picked !== null && rows.some((row) => row.id === picked)
      ? picked
      : (rows[0]?.id ?? null);

  return (
    // Not `PageShell`: this screen is master-detail, with its own header band
    // and internal scroller, where PageShell gives a padded region of
    // 24px-gapped bands and its own h1. It still needs PageShell's antigravity
    // height rule, so both take it from one definition — `height: 100%` cannot
    // resolve against `RequireAuth`'s `minHeight` parent, so this shell fell
    // back to its content height and the document scrolled while the rail
    // spanned only part of the column. cursor keeps `height: 100%`, because its
    // pages are meant to scroll the document.
    <Stack
      // The nav's axis is the variant's, the same rule `PageShell` follows: on
      // antigravity `ScreenNav` is a 56px vertical rail and must sit BESIDE the
      // page. Without this the default column direction stacked it on top —
      // measured at 1440, `main` began at y=360 under a 56x308 strip instead of
      // beside a full-height rail.
      direction={UI_VARIANT === "antigravity" ? "row" : "column"}
      sx={
        UI_VARIANT === "antigravity"
          ? { ...shellBelowBarSx, minHeight: 0, overflow: "hidden" }
          : { height: "100%", minHeight: 0 }
      }
    >
      <ScreenNav current="/servicos" />
      <Box
        component="main"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        sx={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          outline: "none",
        }}
      >
        <Stack
          spacing={1.5}
          sx={{ px: 3, py: 2, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
        >
          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: "baseline", flexWrap: "wrap" }}
          >
            <Typography
              component="h1"
              sx={{ fontSize: TYPE_SCALE.page, fontWeight: 800 }}
            >
              Serviços
            </Typography>
            {totals ? (
              <Typography sx={{ fontSize: TYPE_SCALE.body, color: "text.secondary" }}>
                {totals.totalCount} {totals.totalCount === 1 ? "serviço" : "serviços"} ·{" "}
                {formatAmount(totals.totalAmount)}
                {from || to
                  ? ` · ${formatDate(from) || "…"} – ${formatDate(to) || "…"}`
                  : ""}
              </Typography>
            ) : null}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            <TextField
              size="small"
              label="Cliente, placa ou OS"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              sx={{ minWidth: 260 }}
            />
            <TextField
              size="small"
              type="date"
              label="De"
              slotProps={{ inputLabel: { shrink: true } }}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <TextField
              size="small"
              type="date"
              label="Até"
              slotProps={{ inputLabel: { shrink: true } }}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="return-state-label">Situação</InputLabel>
              <Select
                labelId="return-state-label"
                label="Situação"
                value={returnState}
                onChange={(event) =>
                  setReturnState(event.target.value as typeof returnState)
                }
              >
                <MenuItem value="TODAS">Todas</MenuItem>
                {/* Retorno do veículo, not situação da OS — a separate axis, so it
                  gets its own group rather than pretending to be a fifth OS
                  status. Reads the same stored VehicleReturn row Follow-up
                  reads: one definition of vencido, not two. */}
                <MenuItem
                  disabled
                  sx={{
                    opacity: "1 !important",
                    fontWeight: 700,
                    fontSize: TYPE_SCALE.caption,
                  }}
                >
                  Retorno do veículo
                </MenuItem>
                <MenuItem value="vencido" sx={{ pl: 3 }}>
                  Retorno vencido
                </MenuItem>
                <MenuItem value="aproximando" sx={{ pl: 3 }}>
                  Retorno se aproximando
                </MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Stack>

        {list.isLoading ? (
          <Stack spacing={1} sx={{ p: 3 }} role="status">
            <Skeleton variant="rounded" height={64} />
            <Skeleton variant="rounded" height={64} />
            <Skeleton variant="rounded" height={64} />
            <Typography>Carregando serviços</Typography>
          </Stack>
        ) : list.isError ? (
          <Stack spacing={1} sx={{ p: 3, alignItems: "flex-start" }}>
            <Alert severity="error">Não foi possível carregar os serviços</Alert>
            <Button variant="contained" onClick={() => void list.refetch()}>
              Tentar de novo
            </Button>
          </Stack>
        ) : rows.length === 0 ? (
          <Stack spacing={1} sx={{ p: 6, alignItems: "center" }}>
            <Typography sx={{ fontSize: 15, fontWeight: 600 }}>
              {filtered
                ? "Nenhum serviço para esses filtros"
                : "Nenhum serviço registrado"}
            </Typography>
            <Typography sx={{ fontSize: TYPE_SCALE.body, color: "text.secondary" }}>
              {filtered
                ? "Ajuste a busca ou o período para ver outros serviços."
                : "Nenhuma OS do Omie foi importada para esta unidade."}
            </Typography>
          </Stack>
        ) : (
          <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
            <Stack
              sx={{
                width: 420,
                flexShrink: 0,
                borderRight: 1,
                borderColor: "divider",
                overflow: "auto",
              }}
            >
              {rows.map((row) => (
                <ServiceRow
                  key={row.id}
                  row={row}
                  selected={row.id === selected}
                  onSelect={() => setPicked(row.id)}
                />
              ))}
              {list.hasNextPage ? (
                <Box sx={{ p: 1.5 }}>
                  <Button
                    size="small"
                    fullWidth
                    variant="outlined"
                    disabled={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {list.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
                  </Button>
                </Box>
              ) : null}
            </Stack>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {selected === null ? null : <ServiceDetailPane serviceId={selected} />}
            </Box>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
