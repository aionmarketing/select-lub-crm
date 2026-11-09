/**
 * Programar mensagem dialog, plus the service and scheduled-message rows on the
 * Conversas rail and the two orders those lists are read in.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  ScheduledMessage,
  ScheduledMessageStatus,
  Service,
  Vehicle,
} from "@select-lub/shared-types";
import {
  createScheduledMessage,
  fetchTemplates,
  previewTemplate,
  suggestScheduleDate,
} from "../api.js";
import {
  datetimeLocalToIso,
  formatAmount,
  formatOdometer,
  formatPerformedAt,
  formatScheduleDate,
  isoToDatetimeLocal,
  joinDot,
  vehicleIdentity,
} from "./helpers.js";

/** Portuguese label per outbox state, shown on every scheduled-message surface. */
export const SCHEDULE_STATUS_LABELS: Record<ScheduledMessageStatus, string> = {
  SCHEDULED: "Programada",
  PROCESSING: "Processando",
  SENT: "Enviada",
  CANCELLED: "Cancelada",
  FAILED: "Falhou",
};

/** States a message can still leave on its own; the rest are resolved. */
const PENDING_SCHEDULE_STATUSES: ScheduledMessageStatus[] = ["SCHEDULED", "PROCESSING"];

/**
 * São Paulo calendar date and clock time of a scheduled instant.
 * @param iso - UTC timestamp from `scheduledAt`
 * @returns `DD/MM/YYYY HH:mm`; the zone itself is stated beside it, never inferred from the reader's clock
 */
export function formatScheduleInstant(iso: string): string {
  const date = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return date.replace(", ", " ");
}

/**
 * Newest `createdAt` first — the order the rail PREVIEW reads in, so a message
 * just confirmed is the first row the attendant sees.
 * @param rows - This conversation's scheduled messages
 */
export function sortSchedulesNewestFirst(rows: ScheduledMessage[]): ScheduledMessage[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Soonest pending send first, then resolved rows most recent first — the order
 * the Ver tudo list reads in, because that list answers "what goes out next"
 * rather than "what did I just create".
 * @param rows - This conversation's scheduled messages
 */
export function sortSchedulesBySendOrder(rows: ScheduledMessage[]): ScheduledMessage[] {
  const pending = rows.filter((row) => PENDING_SCHEDULE_STATUSES.includes(row.status));
  const resolved = rows.filter((row) => !PENDING_SCHEDULE_STATUSES.includes(row.status));
  return [
    ...pending.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
    ...resolved.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)),
  ];
}

/**
 * First line of a scheduled message's frozen text, used as its row title.
 *
 * The list contract carries no template name — only the detail read resolves
 * one — so the row names the message by what will actually be sent rather than
 * by an origin it cannot see. A first line longer than 40 characters is cut
 * there and given an ellipsis; 40 itself stays whole.
 *
 * @param text - Frozen message body
 */
export function scheduleRowTitle(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function ScheduleMessageDialog({
  conversationId,
  customerName,
  service,
  connected,
  scheduleBlocked,
  onClose,
}: {
  conversationId: string;
  customerName: string;
  service: Service;
  connected: boolean;
  scheduleBlocked: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState("");
  const [text, setText] = useState("");
  // Date and time are separate controls, as the canvas draws them: an
  // attendant scheduling a reminder picks a day and then an hour of the
  // working day, and one combined field made the hour easy to leave at
  // whatever the suggestion carried.
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const serviceLabel = joinDot([
    formatPerformedAt(service.performedAt),
    service.description ?? service.kind,
  ]);
  const suggestQuery = useQuery({
    queryKey: ["suggest-schedule-date", service.id],
    queryFn: () => suggestScheduleDate(service.id),
  });
  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
  });
  const createSchedule = useMutation({
    mutationFn: () =>
      createScheduledMessage(conversationId, {
        text: text.trim(),
        scheduledAt: datetimeLocalToIso(`${date}T${time}`),
        serviceId: service.id,
        templateId: templateId || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["scheduled-messages", conversationId] });
      // The confirmed message is read on the rail's Mensagens programadas
      // section, not here — this dialog holds only the form.
      onClose();
    },
  });

  useEffect(() => {
    if (suggestQuery.data?.suggestedAt && date === "" && time === "") {
      const [suggestedDate, suggestedTime] = isoToDatetimeLocal(
        suggestQuery.data.suggestedAt,
      ).split("T");
      setDate(suggestedDate ?? "");
      setTime(suggestedTime ?? "");
    }
  }, [suggestQuery.data, date, time]);

  const activeTemplates = (templatesQuery.data ?? []).filter((row) => row.status === "active");
  const occupiedReason = "Este serviço já tem uma mensagem programada.";
  const confirmBlocked =
    !connected ||
    scheduleBlocked ||
    text.trim() === "" ||
    date === "" ||
    time === "" ||
    createSchedule.isPending;
  const disconnectedReason = "Envio pelo CRM indisponível.";

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Programar mensagem</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!connected ? <Alert severity="warning">{disconnectedReason}</Alert> : null}
          {scheduleBlocked ? <Alert severity="warning">{occupiedReason}</Alert> : null}
          {serviceLabel ? (
            <Typography variant="body2">
              Pré-preenchido a partir do serviço &quot;{serviceLabel}&quot;
            </Typography>
          ) : null}
          <Typography variant="body2">Cliente: {customerName}</Typography>
          {suggestQuery.isLoading ? (
            <Stack spacing={1} role="status">
              <Skeleton variant="rounded" height={40} />
              <Typography>Carregando data sugerida</Typography>
            </Stack>
          ) : suggestQuery.isError ? (
            <Alert severity="error">Não foi possível carregar a data sugerida</Alert>
          ) : suggestQuery.data ? (
            <Typography variant="body2">
              Data sugerida: {formatScheduleDate(suggestQuery.data.suggestedAt)}
            </Typography>
          ) : null}
          {activeTemplates.length > 0 ? (
            <FormControl size="small" fullWidth>
              <InputLabel id="schedule-template-label">Template</InputLabel>
              <Select
                labelId="schedule-template-label"
                label="Template"
                value={templateId}
                onChange={(event) => {
                  const nextId = String(event.target.value);
                  setTemplateId(nextId);
                  if (!nextId) {
                    return;
                  }
                  void previewTemplate(conversationId, nextId)
                    .then(setText)
                    .catch(() => {
                      const fallback = activeTemplates.find((row) => row.id === nextId);
                      if (fallback) {
                        setText(fallback.text);
                      }
                    });
                }}
              >
                <MenuItem value="">Nenhum</MenuItem>
                {activeTemplates.map((row) => (
                  <MenuItem key={row.id} value={row.id}>
                    {row.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          <TextField
            label="Mensagem"
            helperText="Editável antes de programar"
            size="small"
            multiline
            minRows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            slotProps={{ htmlInput: { "data-testid": "conversas-schedule-text" } }}
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="Data"
              type="date"
              size="small"
              fullWidth
              value={date}
              onChange={(event) => setDate(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Hora"
              type="time"
              size="small"
              fullWidth
              value={time}
              onChange={(event) => setTime(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Fuso America/Sao_Paulo
          </Typography>
          {createSchedule.isError ? (
            <Alert severity="error">Não foi possível programar a mensagem</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Fechar</Button>
        <Tooltip title={connected ? (scheduleBlocked ? occupiedReason : "") : disconnectedReason}>
          <span>
            <Button
              variant="contained"
              data-testid="conversas-schedule-confirm"
              disabled={confirmBlocked}
              onClick={() => createSchedule.mutate()}
            >
              Confirmar
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}

export function ServiceRailRow({
  service,
  vehicle,
  showOdometer,
  onProgramar,
  onOpenDrillIn,
  scheduleBlocked,
}: {
  service: Service;
  vehicle: Vehicle | undefined;
  showOdometer: boolean;
  onProgramar: () => void;
  onOpenDrillIn: () => void;
  scheduleBlocked: boolean;
}) {
  const title = joinDot([formatPerformedAt(service.performedAt), service.description ?? service.kind]);
  const drillLabel = title || "serviço";
  const subtitle = joinDot([
    vehicleIdentity(vehicle),
    formatAmount(service.amount),
    showOdometer ? formatOdometer(service.odometerKm) : "",
  ]);
  const blockedReason = "Este serviço já tem uma mensagem programada.";
  return (
    <Paper variant="outlined" sx={{ p: 1, borderRadius: 1 }}>
      <Stack spacing={0.5}>
        <Button
          size="small"
          onClick={onOpenDrillIn}
          aria-label={`Ver ${drillLabel}`}
          sx={{ justifyContent: "space-between", textAlign: "left", textTransform: "none" }}
        >
          <Box component="span" sx={{ fontWeight: 600 }}>
            {title || "Serviço"}
          </Box>
          <Box component="span" aria-hidden>
            {" ›"}
          </Box>
        </Button>
        {subtitle ? (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        ) : null}
        <Button
          size="small"
          variant="outlined"
          data-testid={scheduleBlocked ? "conversas-programar-occupied" : "conversas-programar-free"}
          data-service-id={service.id}
          onClick={onProgramar}
        >
          Programar mensagem
        </Button>
        {scheduleBlocked ? (
          <Typography variant="caption" color="text.secondary">
            {blockedReason}
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );
}

/**
 * One scheduled message on the rail — its first line, its send instant and its
 * Portuguese state, opening the drill-in rather than a dialog.
 *
 * @param row - Scheduled message from the conversation list read
 * @param onOpenDrillIn - Switches the rail to this message's detail view
 */
export function ScheduledRailRow({
  row,
  onOpenDrillIn,
}: {
  row: ScheduledMessage;
  onOpenDrillIn: () => void;
}) {
  const title = scheduleRowTitle(row.text);
  return (
    <Paper variant="outlined" sx={{ p: 1, borderRadius: 1 }}>
      <Stack spacing={0.5}>
        <Button
          size="small"
          onClick={onOpenDrillIn}
          aria-label={`Ver mensagem programada ${title}`}
          data-testid="conversas-programada-row"
          sx={{ justifyContent: "space-between", textAlign: "left", textTransform: "none" }}
        >
          <Box component="span" sx={{ fontWeight: 600 }}>
            {title}
          </Box>
          <Box component="span" aria-hidden>
            {" ›"}
          </Box>
        </Button>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="caption" color="text.secondary">
            {formatScheduleInstant(row.scheduledAt)}
          </Typography>
          <Chip size="small" label={SCHEDULE_STATUS_LABELS[row.status]} />
        </Stack>
      </Stack>
    </Paper>
  );
}
