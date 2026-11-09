/**
 * Rail drill-ins: one service and one scheduled message, each shown in full.
 *
 * These are rail VIEWS, not dialogs. The canvas puts both details in the rail
 * so the inbox and the thread stay on screen while the attendant reads them —
 * a dialog would cover the conversation the detail is about. Each therefore
 * owns a Voltar control back to the list it was opened from.
 */
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServiceDetail } from "@select-lub/shared-types";
import {
  cancelScheduledMessage,
  fetchScheduledMessageDetail,
  fetchServiceDetail,
  isCancelAlreadySending,
  isCancelDisconnected,
} from "../api.js";
import { formatAmount, formatOdometer, formatPerformedAt, joinDot } from "./helpers.js";
import { SCHEDULE_STATUS_LABELS, formatScheduleInstant, scheduleRowTitle } from "./schedule.js";

/** Portuguese fallback for a field the OS or the message left unset. */
const NOT_INFORMED = "Não informado";

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
      <Typography variant="caption" color="text.secondary" sx={{ width: 112, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1 }}>
        {value}
      </Typography>
    </Stack>
  );
}

function DrillInHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
      <Button size="small" onClick={onBack}>
        ← Voltar
      </Button>
      <Typography variant="subtitle1">{title}</Typography>
    </Stack>
  );
}

/**
 * Vehicle identity of a service-detail row, built from the labels the detail
 * read already carries — the rail's vehicle list is never consulted, so a
 * service performed on a car the customer no longer owns still names its car.
 */
function detailVehicleLabel(row: ServiceDetail): string {
  const identity = [
    row.vehicleMake,
    row.vehicleModel,
    row.vehicleYear == null ? null : String(row.vehicleYear),
  ]
    .filter((part): part is string => part != null && part.trim() !== "")
    .join(" ");
  return joinDot([identity, row.vehiclePlate]);
}

/**
 * One service, in full, as a rail view.
 *
 * @param serviceId - OS id from the row that was activated
 * @param onBack - Returns to the list the drill-in was opened from
 * @param onProgramar - Opens the Programar mensagem form for this service; receives the loaded detail, which is a `Service` plus the detail-only fields
 */
export function ServiceDrillIn({
  serviceId,
  onBack,
  onProgramar,
}: {
  serviceId: string;
  onBack: () => void;
  onProgramar: (service: ServiceDetail) => void;
}) {
  const query = useQuery({
    queryKey: ["service-detail", serviceId],
    queryFn: () => fetchServiceDetail(serviceId),
  });
  const row = query.data;
  const title = row
    ? joinDot([formatPerformedAt(row.performedAt), row.description ?? row.kind]) || "Serviço"
    : "Serviço";

  return (
    <Stack spacing={2} component="section" aria-label="Serviço">
      <DrillInHeader title={title} onBack={onBack} />
      {query.isLoading ? (
        <Stack spacing={1} role="status">
          <Skeleton variant="rounded" height={48} />
          <Typography>Carregando serviço</Typography>
        </Stack>
      ) : query.isError || !row ? (
        <Stack spacing={1}>
          <Alert severity="error">Não foi possível carregar o serviço</Alert>
          <Button variant="contained" onClick={() => void query.refetch()}>
            Tentar de novo
          </Button>
        </Stack>
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
            <Stack spacing={0.75}>
              <KeyValue label="Veículo" value={detailVehicleLabel(row) || "Sem veículo vinculado"} />
              <KeyValue
                label="Quilometragem"
                value={formatOdometer(row.odometerKm) || NOT_INFORMED}
              />
              <KeyValue label="Situação" value={row.status ?? NOT_INFORMED} />
              <KeyValue label="Origem" value={row.omieId ? `Omie · OS ${row.omieId}` : row.origin} />
            </Stack>
          </Paper>
          <Typography variant="subtitle2">Itens</Typography>
          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
            {row.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nenhum item lançado nesta OS
              </Typography>
            ) : (
              <Stack spacing={0.75}>
                {row.items.map((item) => (
                  <Stack key={item.id} direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {item.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.quantity == null ? "" : `${item.quantity} ×`}
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {formatAmount(item.lineAmount)}
                    </Typography>
                  </Stack>
                ))}
                <Divider />
                <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
                    Total
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 800 }}>
                    {formatAmount(row.amount)}
                  </Typography>
                </Stack>
              </Stack>
            )}
          </Paper>
          <Typography variant="subtitle2">Orçamento de origem</Typography>
          {row.attributedQuote ? (
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  Orçamento enviado em {formatPerformedAt(row.attributedQuote.sentAt)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Atribuído a este serviço pela regra de 30 dias (versão{" "}
                  {row.attributedQuote.ruleVersion})
                </Typography>
              </Stack>
            </Paper>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Nenhum orçamento atribuído a este serviço
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            sx={{ alignSelf: "flex-start" }}
            onClick={() => onProgramar(row)}
          >
            Programar mensagem
          </Button>
        </>
      )}
    </Stack>
  );
}

/**
 * One scheduled message, in full, as a rail view.
 *
 * Cancel lives here rather than on the list row: cancelling is the destructive
 * action on a queued send, and the detail is where the attendant can read the
 * text that would actually go out before stopping it.
 *
 * @param scheduleId - Scheduled message id from the row that was activated
 * @param conversationId - Conversation the cancel is posted through
 * @param connected - Whether the channel state is `CONNECTED`; cancel is blocked with a Portuguese reason when it is not
 * @param onBack - Returns to the list the drill-in was opened from
 */
export function ScheduledMessageDrillIn({
  scheduleId,
  conversationId,
  connected,
  onBack,
}: {
  scheduleId: string;
  conversationId: string;
  connected: boolean;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["scheduled-message-detail", scheduleId],
    queryFn: () => fetchScheduledMessageDetail(scheduleId),
  });
  const refreshSchedule = () => {
    void queryClient.invalidateQueries({ queryKey: ["scheduled-message-detail", scheduleId] });
    void queryClient.invalidateQueries({ queryKey: ["scheduled-messages", conversationId] });
  };
  const cancelSchedule = useMutation({
    mutationFn: () => cancelScheduledMessage(conversationId, scheduleId),
    onSuccess: refreshSchedule,
    onError: (error) => {
      // Already on its way (owner rulings, 2026-09-25): nothing was cancelled,
      // so re-read the row and let its own status say sent or still sending.
      if (isCancelAlreadySending(error)) refreshSchedule();
    },
  });
  const row = query.data;
  const disconnectedReason = "Envio pelo CRM indisponível.";
  const cancelError = cancelSchedule.isError
    ? isCancelAlreadySending(cancelSchedule.error)
      ? "Esta mensagem já está sendo enviada ou já foi enviada, e não pode mais ser cancelada."
      : isCancelDisconnected(cancelSchedule.error)
        ? disconnectedReason
        : "Não foi possível cancelar o envio. Tente de novo."
    : null;

  return (
    <Stack spacing={2} component="section" aria-label="Mensagem programada">
      <DrillInHeader
        title={row ? scheduleRowTitle(row.text) : "Mensagem programada"}
        onBack={onBack}
      />
      {query.isLoading ? (
        <Stack spacing={1} role="status">
          <Skeleton variant="rounded" height={48} />
          <Typography>Carregando mensagem programada</Typography>
        </Stack>
      ) : query.isError || !row ? (
        <Stack spacing={1}>
          <Alert severity="error">Não foi possível carregar a mensagem programada</Alert>
          <Button variant="contained" onClick={() => void query.refetch()}>
            Tentar de novo
          </Button>
        </Stack>
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
            <Stack spacing={0.75}>
              <KeyValue
                label="Envio"
                value={`${formatScheduleInstant(row.scheduledAt)} · ${row.timeZone}`}
              />
              <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ width: 112, flexShrink: 0 }}
                >
                  Situação
                </Typography>
                <Chip size="small" label={SCHEDULE_STATUS_LABELS[row.status]} />
              </Stack>
              <KeyValue label="Template" value={row.templateName ?? "Sem template"} />
              <KeyValue
                label="Serviço"
                value={
                  row.originatingService
                    ? joinDot([
                        formatPerformedAt(row.originatingService.performedAt),
                        row.originatingService.description,
                      ]) || "Serviço sem descrição"
                    : "Sem serviço de origem"
                }
              />
              <KeyValue label="Criada por" value={row.createdByName ?? NOT_INFORMED} />
            </Stack>
          </Paper>
          {row.lastError ? <Alert severity="error">Falhou · {row.lastError}</Alert> : null}
          <Typography variant="subtitle2">Texto</Typography>
          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {row.text}
            </Typography>
          </Paper>
          {row.status === "SCHEDULED" ? (
            <>
              <Tooltip title={connected ? "" : disconnectedReason}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ alignSelf: "flex-start" }}
                    disabled={!connected || cancelSchedule.isPending}
                    onClick={() => cancelSchedule.mutate()}
                  >
                    Cancelar envio
                  </Button>
                </span>
              </Tooltip>
              {connected ? null : (
                <Typography variant="caption" color="text.secondary">
                  {disconnectedReason}
                </Typography>
              )}
            </>
          ) : null}
          {cancelError ? (
            <Alert severity={isCancelAlreadySending(cancelSchedule.error) ? "info" : "error"}>
              {cancelError}
            </Alert>
          ) : null}
        </>
      )}
    </Stack>
  );
}
