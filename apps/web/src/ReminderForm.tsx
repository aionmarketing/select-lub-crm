/**
 * Creating a reminder on a vehicle return, from the Follow-up queue.
 *
 * Prefilled from the return the operator clicked: its vehicle, its date, and
 * the conversation the messages will go to. The text is composed for them and
 * editable; the send moments are a list they can add to and remove from.
 */
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FollowUpDueVehicle, ReminderTriggerBody } from "@select-lub/shared-types";
import { createReturnReminder } from "./api/returnReminders.js";
import { TYPE_SCALE } from "./theme.js";

/**
 * The hour a new moment opens on, in the store's timezone.
 *
 * Shown in the form rather than applied behind it, so nothing is ever sent at
 * an hour the attendant was not shown. They can change it before confirming.
 */
const DEFAULT_HOUR = { hour: 9, minute: 0 };

/** A moment as the form holds it: a local date and a time, both editable. */
type Moment = { day: string; hour: number; minute: number };

function isoDay(iso: string) {
  return iso.slice(0, 10);
}

function todayISO(now: Date) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * The moment a new reminder opens with.
 *
 * On a return still ahead this is the return date itself — the plain reading of
 * "remind me when it is due". On an OVERDUE return that same date is in the
 * past and the write would be refused, so it opens on tomorrow instead: the
 * busiest section of the screen is Retorno vencido, and its natural default
 * must not be one the server rejects.
 *
 * @param returnDate - The return's stored date, as an ISO instant.
 * @param now - Current time, injected so the choice is testable.
 * @returns One moment, the list's only entry until the operator adds another.
 */
export function defaultMoment(returnDate: string, now: Date): Moment {
  const due = isoDay(returnDate);
  const today = todayISO(now);
  if (due > today) {
    return { day: due, ...DEFAULT_HOUR };
  }
  const tomorrow = new Date(now.getTime() + 86_400_000);
  return { day: todayISO(tomorrow), ...DEFAULT_HOUR };
}

/**
 * Turns a form moment into a wire trigger.
 *
 * Always `absolute`: the operator picked a calendar day, and an offset would
 * silently move if the return date were later edited — which is the opposite
 * of what naming a date means.
 */
function toTrigger(moment: Moment): ReminderTriggerBody {
  const at = new Date(`${moment.day}T00:00:00`);
  at.setHours(moment.hour, moment.minute, 0, 0);
  return { kind: "absolute", at: at.toISOString() };
}

function timeValue(moment: Moment) {
  return `${String(moment.hour).padStart(2, "0")}:${String(moment.minute).padStart(2, "0")}`;
}

/** What each refusal means, in the operator's language. */
const REFUSALS: Record<string, string> = {
  trigger_in_past: "Um dos avisos está no passado. Escolha uma data à frente.",
  duplicate_trigger: "Dois avisos caem no mesmo momento. Mude ou remova um deles.",
  return_not_open: "Este retorno foi arquivado. Desarquive-o para criar lembretes.",
  no_performed_at: "O serviço de origem não tem data, então não dá para medir o tempo decorrido.",
  no_triggers: "Um lembrete precisa de pelo menos um aviso.",
};

function refusalCopy(error: unknown) {
  const body = (error as { body?: { error?: string; state?: string } })?.body;
  if (body?.state === "DISCONNECTED") {
    return "Envio pelo CRM indisponível. Reconecte o número para programar.";
  }
  return (body?.error && REFUSALS[body.error]) ?? "Não foi possível criar o lembrete.";
}

/**
 * The Criar lembrete dialog for one vehicle's return.
 *
 * @param vehicle - The return's vehicle, carrying its id and date.
 * @param customerName - Who the messages go to, shown for confirmation.
 * @param conversationId - Where the messages send; null blocks confirm, since
 *   a reminder with nowhere to go cannot be created.
 * @param connected - False disables confirm rather than letting the operator
 *   submit into a refusal.
 * @param now - Current time, injected so the default moment is testable.
 * @param onClose - Called on cancel and after a successful create.
 */
export function ReminderForm({
  vehicle,
  customerName,
  conversationId,
  connected,
  now,
  onClose,
}: {
  vehicle: FollowUpDueVehicle;
  customerName: string;
  conversationId: string | null;
  connected: boolean;
  now: Date;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [moments, setMoments] = useState<Moment[]>([defaultMoment(vehicle.returnDate, now)]);
  const [text, setText] = useState("");

  const create = useMutation({
    mutationFn: () =>
      createReturnReminder(vehicle.returnId, {
        conversationId: conversationId ?? "",
        triggers: moments.map(toTrigger),
        ...(text.trim() === "" ? {} : { bodyTemplate: text.trim() }),
      }),
    onSuccess: () => {
      // The row's summary — "2 lembretes · próximo 04/09" — is drawn from the
      // Follow-up read, so it refreshes here rather than on a reload.
      void queryClient.invalidateQueries({ queryKey: ["follow-up"] });
      onClose();
    },
  });

  const setMoment = (index: number, patch: Partial<Moment>) =>
    setMoments((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const blocked = !connected || conversationId === null || moments.length === 0 || create.isPending;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Criar lembrete</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!connected ? (
            <Alert severity="warning">Envio pelo CRM indisponível.</Alert>
          ) : null}
          {conversationId === null ? (
            <Alert severity="warning">
              Este cliente não tem conversa, então não há para onde enviar o lembrete.
            </Alert>
          ) : null}

          <Typography variant="body2">
            {customerName} · {[vehicle.model, vehicle.plate].filter(Boolean).join(" · ")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Retorno previsto {isoDay(vehicle.returnDate).split("-").reverse().join("/")}
          </Typography>

          <TextField
            label="Mensagem"
            size="small"
            multiline
            minRows={3}
            placeholder="Deixe em branco para usar o texto padrão"
            value={text}
            onChange={(event) => setText(event.target.value)}
            slotProps={{ htmlInput: { "data-testid": "reminder-text" } }}
          />

          <Stack spacing={1}>
            <Typography sx={{ fontSize: TYPE_SCALE.subsection, fontWeight: 700 }}>
              Avisos
            </Typography>
            {moments.map((moment, index) => (
              <Stack key={index} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <TextField
                  label="Dia"
                  type="date"
                  size="small"
                  value={moment.day}
                  onChange={(event) => setMoment(index, { day: event.target.value })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                  label="Hora"
                  type="time"
                  size="small"
                  value={timeValue(moment)}
                  onChange={(event) => {
                    const [h, m] = event.target.value.split(":");
                    setMoment(index, { hour: Number(h), minute: Number(m) });
                  }}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <IconButton
                  size="small"
                  aria-label={`Remover aviso ${index + 1}`}
                  disabled={moments.length === 1}
                  onClick={() => setMoments((list) => list.filter((_, i) => i !== index))}
                >
                  ✕
                </IconButton>
              </Stack>
            ))}
            <Button
              size="small"
              sx={{ alignSelf: "flex-start" }}
              onClick={() =>
                setMoments((list) => [...list, defaultMoment(vehicle.returnDate, now)])
              }
            >
              + Outro aviso
            </Button>
            <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
              Cada aviso vira uma mensagem programada própria, com o texto já resolvido para o
              momento dela.
            </Typography>
          </Stack>

          {create.isError ? <Alert severity="error">{refusalCopy(create.error)}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          variant="contained"
          data-testid="reminder-confirm"
          disabled={blocked}
          onClick={() => create.mutate()}
        >
          Confirmar
        </Button>
      </DialogActions>
    </Dialog>
  );
}
