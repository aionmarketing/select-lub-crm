/**
 * Operational Follow-up screen — unanswered quotes, overdue and upcoming vehicle
 * returns, and conversations still waiting on a reply.
 *
 * Framed as the PDF artboard `artboard-followup-pdf.png`: the shared
 * `PageShell` with the unit as a chip beside the title, four count cards whose
 * section name is an uppercase caption above the number, and each section a
 * heading with its ordering subtitle above one borderless card.
 *
 * Four counts, three lists. **Mensagens aguardando resposta leads the card row**
 * and its list renders only while its own card is selected: Conversas is where
 * an unanswered message gets answered, so listing them here as well would be a
 * second inbox competing with the first — the count still matters, the list is
 * on demand.
 *
 * Entries are **arquivadas**, never "fechadas" or "ocultas" (the vocabulary
 * decided in the 2026-09-02 review). The archived set is not a screen of its
 * own: each section whose archived set is not empty ends its card with a
 * one-line strip naming who is archived, and opening that strip lists them
 * inside the same card while every other section keeps showing its queue.
 * There is deliberately no snooze: an entry either still needs work or it does
 * not, and a date-based hide puts it back with no new information, which is how
 * a queue teaches people to ignore it.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import type {
  FollowUpDueVehicle,
  FollowUpOptionalCounts,
  FollowUpResult,
} from "@select-lub/shared-types";
import {
  fetchFollowUp,
  fetchFollowUpCounts,
  fetchUnits,
  setFollowUpClosed,
} from "./api.js";
import { archiveVehicleReturn, unarchiveVehicleReturn, type ReminderRefusal } from "./api/returnReminders.js";
import { useAuthSession } from "./authSession.js";
import { cardSx, PageSection, PageShell } from "./PageShell.js";
import { ReminderForm } from "./ReminderForm.js";
import { TYPE_SCALE, TOUCH_TARGET_PX } from "./theme.js";

/** Card order is the approved one: the count-only section leads. */
const SECTIONS = [
  {
    key: "waitingReply",
    title: "Mensagens aguardando resposta",
    empty: "Nenhuma mensagem aguardando resposta.",
    /** Rendered only while its own card is selected. */
    onDemand: true,
  },
  {
    key: "unansweredQuotes",
    title: "Orçamentos sem resposta",
    empty: "Nenhum orçamento sem resposta.",
    onDemand: false,
  },
  {
    key: "overdueReturns",
    title: "Retorno vencido",
    empty: "Nenhum retorno vencido.",
    onDemand: false,
  },
  {
    key: "upcomingReturns",
    title: "Retorno se aproximando",
    empty: "Nenhum retorno se aproximando.",
    onDemand: false,
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

/**
 * Whether an unarchive was refused because the return is no longer archived:
 * a newer service replaced it, or the vehicle already has an open return
 * (409 `return_not_archived`).
 *
 * @param error - What the archive mutation rejected with.
 * @returns True for that refusal.
 */
function isReturnReplaced(error: unknown): boolean {
  const refusal = error as Partial<ReminderRefusal> | null;
  return refusal?.status === 409 && refusal.body?.error === "return_not_archived";
}

/**
 * What an archive or unarchive acts on.
 *
 * Two subjects, because the two halves of the screen suppress through different
 * rows: a message-pendency entry suppresses through the closed-entry table
 * against the anchor that qualified it, while a return archives the return
 * itself, which is the row that already exists to say so. The return arm
 * carries a list rather than one id because a Retorno vencido entry IS one
 * customer with every late car of theirs, and its head mark archives that one
 * entry — the cars open right now. A newer service on any of those cars opens a
 * fresh return that lists here as normal, which is why archiving is safe. The
 * screen used to say so in a caption under each customer; the owner dropped
 * that at the 2026-09-05 sign-off because it repeated once per customer, and
 * the caveat now reaches the reader through {@link OVERDUE_ARCHIVE_LABEL} —
 * absent visually, present to a screen reader at the control itself.
 */
type CloseTarget =
  | {
      kind: "entry";
      section: "unansweredQuotes" | "waitingReply";
      conversationId: string;
      anchor: string;
    }
  | { kind: "return"; returnIds: string[] };

const MS_PER_DAY = 86_400_000;

/**
 * Row actions read as actions.
 *
 * A bare text button sat at the weight of the body copy beside it and near the
 * weight of MUI's disabled grey, so the one control on the row that does
 * something looked like the two things that do not. The border plus the brand
 * colour separates it from both, and from the filled reminder chip.
 */
const ROW_ACTION = { size: "small", variant: "outlined", color: "primary" } as const;

/** The drawn × inside the 44px hit target, at the artboard's stroke size. */
const ARCHIVE_MARK_GLYPH = 13;

/**
 * The accessible name of the head mark on a Retorno vencido customer entry.
 *
 * Longer than the other two marks' names because it carries the reversibility
 * caveat as well as the subject. That caveat used to be a caption printed under
 * every customer in the section; the owner took it off the screen at the
 * 2026-09-05 sign-off because it repeated once per customer, and chose to have
 * it return here instead. This is now the only place the reader is told that
 * archiving is not permanent.
 *
 * One sentence on purpose: a name is announced in a single breath at the moment
 * the user is deciding whether to press the control, so the deleted five-line
 * block would be worse here than it was on the screen.
 */
const OVERDUE_ARCHIVE_LABEL =
  "Arquivar os retornos abertos deste cliente; um serviço novo em qualquer carro do cliente abre um retorno novo aqui.";

function formatDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/**
 * Whole days from an instant to now, floored — the unit every caption speaks in.
 *
 * @param fromIso - The instant the elapsed time is measured from.
 * @param now - The clock, passed in so one render dates every row the same way.
 * @returns Days elapsed; negative when `fromIso` is in the future, and 0 when
 *   the string is not a date this can read.
 */
function daysSince(fromIso: string, now: Date) {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) {
    return 0;
  }
  return Math.floor((now.getTime() - from) / MS_PER_DAY);
}

function days(count: number) {
  return `${count} ${count === 1 ? "dia" : "dias"}`;
}

/**
 * "1 cliente" / "2 clientes" — the count and the noun that agrees with it.
 *
 * @param count - How many.
 * @param one - Singular noun.
 * @param many - Plural noun.
 * @returns The count and its noun, space separated.
 */
function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The caption that makes a return row urgent.
 *
 * Elapsed time leads and the date is secondary: "retorno previsto 16/07/2026"
 * makes the reader subtract dates to learn the thing they came for.
 *
 * @param returnDate - Stored return day, `YYYY-MM-DD`.
 * @param now - The clock.
 * @returns "95 dias em atraso", "vence hoje", or "vence em 3 dias".
 */
function returnAge(returnDate: string, now: Date) {
  const elapsed = daysSince(`${returnDate}T00:00:00.000Z`, now);
  if (elapsed > 0) {
    return `${days(elapsed)} em atraso`;
  }
  return elapsed === 0 ? "vence hoje" : `vence em ${days(-elapsed)}`;
}

/**
 * "2 lembretes · próximo 04/09/2026".
 *
 * Never a bare "Já agendada": a return may carry several reminders, and the
 * operator's next question is always how many and when the next one lands.
 *
 * @param vehicle - The listed vehicle.
 * @returns The summary, or null when the return holds no un-sent reminder.
 */
function plannedLabel(vehicle: FollowUpDueVehicle) {
  const planned = vehicle.plannedReminders;
  if (!planned) {
    return null;
  }
  const noun = planned.count === 1 ? "lembrete" : "lembretes";
  return `${planned.count} ${noun} · próximo ${formatDay(planned.nextAt)}`;
}

function vehicleName(vehicle: FollowUpDueVehicle) {
  return (
    [vehicle.model, vehicle.plate].filter(Boolean).join(" · ") ||
    "Veículo sem identificação"
  );
}

/**
 * Where an entry opens the conversation.
 *
 * @param conversationId - The thread, or null when the entry has none.
 * @param messageId - The message to open positioned on. Absent or unknown
 *   degrades to the thread's normal position — Conversas matches the id against
 *   the rows it rendered and marks nothing when none of them is it.
 * @returns The Conversas path.
 */
function conversationHref(conversationId: string | null, messageId?: string | null) {
  if (!conversationId) {
    return "/";
  }
  return messageId
    ? `/?conversation=${conversationId}&message=${messageId}`
    : `/?conversation=${conversationId}`;
}

/**
 * The ordering a section's heading promises, printed as the artboard prints it.
 *
 * The two return sections count what they are about before naming the order
 * ("2 clientes · 3 veículos · mais atrasado primeiro"), because the heading is
 * the only place the reader learns how big the queue is without scrolling it.
 *
 * @param sectionKey - Which section the heading belongs to.
 * @param data - The listed result, or undefined while it is still loading.
 * @returns The subtitle text; the bare ordering when there is nothing to count.
 */
function orderingSubtitle(sectionKey: SectionKey, data: FollowUpResult | undefined) {
  if (sectionKey === "overdueReturns") {
    const rows = data?.overdueReturns ?? [];
    const vehicles = rows.reduce((total, row) => total + row.vehicles.length, 0);
    if (rows.length === 0) {
      return "mais atrasado primeiro";
    }
    const customers = plural(rows.length, "cliente", "clientes");
    return `${customers} · ${plural(vehicles, "veículo", "veículos")} · mais atrasado primeiro`;
  }
  if (sectionKey === "upcomingReturns") {
    const rows = data?.upcomingReturns ?? [];
    return rows.length === 0
      ? "mais iminente primeiro"
      : `${plural(rows.length, "veículo", "veículos")} · mais iminente primeiro`;
  }
  return "mais antigo primeiro";
}

/**
 * How many entries a section has archived, and who they concern.
 *
 * Read off the closed view of the same endpoint the queue comes from, so the
 * strip cannot claim a different set from the one opening it lists.
 *
 * @param sectionKey - Which section to summarise.
 * @param closed - The closed-view payload, or undefined when that read failed
 *   or has not landed.
 * @returns Count of archived entries and the names line. Count 0 is the case
 *   that draws no strip at all.
 */
function archivedSummary(sectionKey: SectionKey, closed: FollowUpResult | undefined) {
  if (!closed) {
    return { count: 0, names: "" };
  }
  if (sectionKey === "unansweredQuotes" || sectionKey === "waitingReply") {
    const rows = closed[sectionKey];
    return { count: rows.length, names: rows.map((row) => row.label).join(", ") };
  }
  if (sectionKey === "overdueReturns") {
    const rows = closed.overdueReturns;
    // The count is of returns and the names line is of people: one customer may
    // have two archived cars, and "2 arquivados · Ana Souza, Ana Souza" would
    // read as two different people.
    const vehicles = rows.reduce((total, row) => total + row.vehicles.length, 0);
    return { count: vehicles, names: rows.map((row) => row.label).join(", ") };
  }
  const rows = closed.upcomingReturns;
  return {
    count: rows.length,
    names: rows.map((row) => `${row.label} · ${vehicleName(row.vehicle)}`).join(", "),
  };
}

/**
 * A section's empty card — the artboard's `.empty`.
 *
 * Centred with vertical padding rather than a muted line flush against the
 * card's left edge, where it read as the first row of a list that had not
 * loaded. Centring is what makes an empty card look deliberately empty.
 *
 * @param children - The section's Portuguese empty copy.
 * @returns The centred line.
 */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Typography color="text.secondary" sx={{ textAlign: "center", py: 3 }}>
      {children}
    </Typography>
  );
}

/**
 * The × that archives one entry.
 *
 * A mark rather than a worded button because the artboard puts it at the end of
 * a row that already carries two worded controls; the accessible name says what
 * it archives, so a screen reader loses nothing to the glyph.
 *
 * The glyph is a drawn stroke rather than the typographic `×` character: at the
 * artboard's 13px the character renders as a hairline that all but disappears
 * against the card, and its weight follows whichever font actually loads. Two
 * SVG lines at `currentColor` give the artboard's `.arch` mark the same weight
 * everywhere. `@mui/icons-material` is not a dependency of this app, so
 * `CloseIcon` is not available without adding one for a single 13px mark.
 *
 * The glyph stays 13px (the artboard's `.arch` stroke). The hit target is
 * `TOUCH_TARGET_PX` (44), not the artboard's 26px box: ui-ux-pro-max and
 * WCAG 2.2 AAA 2.5.5 both call for 44×44, and shrinking the IconButton
 * below the theme minimum would hide that under a local override.
 *
 * @param label - The accessible name, naming the subject ("Arquivar este retorno").
 * @param disabled - True while another archive or unarchive is in flight.
 * @param onClick - Runs the archive.
 * @returns The mark.
 */
function ArchiveMark({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      size="small"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      sx={{
        width: TOUCH_TARGET_PX,
        height: TOUCH_TARGET_PX,
        minWidth: TOUCH_TARGET_PX,
        minHeight: TOUCH_TARGET_PX,
        p: 0,
        color: "text.secondary",
        "&:hover": { bgcolor: "surfaceVariant" },
      }}
    >
      <Box
        component="svg"
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 13 13"
        sx={{
          width: ARCHIVE_MARK_GLYPH,
          height: ARCHIVE_MARK_GLYPH,
          display: "block",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        }}
      >
        <line x1="3" y1="3" x2="10" y2="10" />
        <line x1="10" y1="3" x2="3" y2="10" />
      </Box>
    </IconButton>
  );
}

/**
 * The foot strip that keeps a section's archived entries visible.
 *
 * One line, and the count never wraps: the PDF's own export width broke
 * "2 arquivados" across two lines, and the artboard's intent is a single
 * legible line per section.
 *
 * @param count - Entries archived in this section; at least one wherever this
 *   renders, because a section with nothing archived draws no strip.
 * @param names - Who the archived entries concern.
 * @param onOpen - Opens the archived list inside this section's card.
 * @returns The strip.
 */
function ArchivedStrip({
  count,
  names,
  onOpen,
}: {
  count: number;
  names: string;
  onOpen: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={2}
      useFlexGap
      sx={{
        alignItems: "center",
        mt: 1,
        p: 1,
        borderRadius: 1,
        bgcolor: "surfaceVariant",
      }}
    >
      <Typography
        sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700, whiteSpace: "nowrap" }}
      >
        {plural(count, "arquivado", "arquivados")}
      </Typography>
      <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
        {names}
      </Typography>
      <Box sx={{ ml: "auto" }}>
        <Button {...ROW_ACTION} onClick={onOpen}>
          {count === 1 ? "Ver o arquivado" : "Ver os arquivados"}
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * The controls an entry head carries: open the thread, archive the entry.
 *
 * They sit on the entry's own line right after its text rather than at the far
 * edge of the card as the artboard draws them — the owner's decision of
 * 2026-09-05, so a control never travels away from the text it acts on.
 *
 * @param archivedView - True while this section lists its archived entries,
 *   where the only action is putting the entry back in the queue.
 * @param busy - True while an archive or unarchive is in flight.
 * @param href - Where the entry opens. The same target as the entry's own text
 *   link, quote-message position included, so the two cannot disagree about
 *   where this entry goes.
 * @param archiveLabel - Accessible name of the × mark.
 * @param onAct - Archives, or unarchives while `archivedView` is true.
 * @returns The entry's controls.
 */
function EntryActions({
  archivedView,
  busy,
  href,
  archiveLabel,
  onAct,
}: {
  archivedView: boolean;
  busy: boolean;
  href: string;
  archiveLabel: string;
  onAct: () => void;
}) {
  if (archivedView) {
    return (
      <Button {...ROW_ACTION} disabled={busy} onClick={onAct}>
        Desarquivar
      </Button>
    );
  }
  return (
    <>
      <Button {...ROW_ACTION} component={RouterLink} to={href}>
        Abrir conversa
      </Button>
      <ArchiveMark label={archiveLabel} disabled={busy} onClick={onAct} />
    </>
  );
}

/**
 * The identity block of a Retorno se aproximando row — the artboard's `.pair-row`.
 *
 * That section lists one customer-vehicle PAIR per row, so the customer and the
 * car belong to the same row rather than to a head above it. The name leads in
 * bold and the car sits under it as a caption (`.pair-veh`), which is what lets
 * the pair be named once: printing a "Name · Car" title and then a vehicle line
 * repeated the car on every row.
 *
 * @param name - The customer.
 * @param vehicle - Their car, printed as the caption under the name.
 * @param conversationId - Linked from the name when there is a conversation;
 *   null leaves the name as plain text rather than a link to nothing.
 * @returns The two stacked lines.
 */
function PairLead({
  name,
  vehicle,
  conversationId,
}: {
  name: string;
  vehicle: FollowUpDueVehicle;
  conversationId: string | null;
}) {
  return (
    <Stack sx={{ minWidth: 180 }}>
      {conversationId ? (
        <Link
          component={RouterLink}
          to={conversationHref(conversationId)}
          underline="hover"
          sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700 }}
        >
          {name}
        </Link>
      ) : (
        <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700 }}>
          {name}
        </Typography>
      )}
      <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
        {vehicleName(vehicle)}
      </Typography>
    </Stack>
  );
}

/**
 * One vehicle line inside a return entry: identity, how late, its reminders.
 *
 * Its actions sit on this same line right after the date rather than pushed to
 * the far edge of the card (owner's decision, 2026-09-05), so the artboard's
 * spacer between the text and the controls is deliberately not reproduced.
 *
 * @param vehicle - The listed vehicle and its return.
 * @param customerName - Whose car it is, shown in the reminder form.
 * @param conversationId - Where a reminder would send; null blocks creating one.
 * @param now - Current time, for the age and the form's default moment.
 * @param onClose - Archives or unarchives this return.
 * @param archivedView - True while the archived entries are the ones listed,
 *   where the only action is putting the return back in the queue.
 * @param busy - True while an archive or unarchive is in flight.
 * @param lead - Replaces the default vehicle-name slot. Retorno se aproximando
 *   passes a {@link PairLead} because its row IS the customer-vehicle pair; the
 *   overdue sections leave it out, since their customer is already the head
 *   above the vehicle lines.
 * @param openConversation - True to offer Abrir conversa on this row. Set only
 *   where the row is the whole entry: in the overdue sections that action
 *   belongs to the customer head, and repeating it per car would offer the same
 *   thread several times.
 */
function VehicleRow({
  vehicle,
  customerName,
  conversationId,
  now,
  onClose,
  archivedView,
  busy,
  lead,
  openConversation = false,
}: {
  vehicle: FollowUpDueVehicle;
  customerName: string;
  conversationId: string | null;
  now: Date;
  onClose: (target: CloseTarget, action: "close" | "reopen") => void;
  archivedView: boolean;
  busy: boolean;
  lead?: ReactNode;
  openConversation?: boolean;
}) {
  const planned = plannedLabel(vehicle);
  const [creating, setCreating] = useState(false);
  const chip = planned ? <Chip size="small" label={planned} /> : null;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      // The indent is what puts a car under its customer head. A row carrying
      // its own lead IS the entry, so it sits flush with the card like the
      // customer names in the overdue sections do.
      sx={{ alignItems: "center", flexWrap: "wrap", pl: lead ? 0 : 2, py: 0.5 }}
    >
      {lead ?? (
        <Typography sx={{ fontSize: TYPE_SCALE.body, minWidth: 180 }}>
          {vehicleName(vehicle)}
        </Typography>
      )}
      <Typography sx={{ fontSize: TYPE_SCALE.body, fontWeight: 700 }}>
        {returnAge(vehicle.returnDate, now)}
      </Typography>
      <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
        previsto {formatDay(vehicle.returnDate)}
      </Typography>
      {/* The summary opens the message it is about, but only once one has
          actually gone out: an un-sent reminder has no bubble in the thread to
          position on. */}
      {chip && vehicle.sentReminderMessageId && conversationId ? (
        <Link
          component={RouterLink}
          to={conversationHref(conversationId, vehicle.sentReminderMessageId)}
          underline="hover"
        >
          {chip}
        </Link>
      ) : (
        chip
      )}
      {archivedView ? (
        <Button
          {...ROW_ACTION}
          disabled={busy}
          onClick={() =>
            onClose({ kind: "return", returnIds: [vehicle.returnId] }, "reopen")
          }
        >
          Desarquivar
        </Button>
      ) : (
        <>
          {openConversation && conversationId ? (
            <Button
              {...ROW_ACTION}
              component={RouterLink}
              to={conversationHref(conversationId)}
            >
              Abrir conversa
            </Button>
          ) : null}
          <Button {...ROW_ACTION} onClick={() => setCreating(true)}>
            Criar lembrete
          </Button>
          <ArchiveMark
            label="Arquivar este retorno"
            disabled={busy}
            onClick={() =>
              onClose({ kind: "return", returnIds: [vehicle.returnId] }, "close")
            }
          />
        </>
      )}
      {creating ? (
        <ReminderForm
          vehicle={vehicle}
          customerName={customerName}
          conversationId={conversationId}
          connected
          now={now}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Follow-up dashboard at `/follow-up`.
 *
 * @returns Four count cards acting as a section filter, the three default
 *   lists, and the fourth while its own card is selected.
 */
export function FollowUpPage() {
  // Three reads, deliberately. The lists and the counts fail independently, so
  // a failed list read leaves the four numbers on screen instead of taking them
  // down with it; the counts key is the one `ScreenNav`'s badge already uses,
  // so the badge and these cards share a single cache entry and cannot end up
  // claiming different numbers. The closed read feeds every section's archived
  // strip and fails on its own — a section then draws no strip, which reports
  // nothing rather than claiming an empty archive.
  const listsQuery = useQuery({
    queryKey: ["follow-up", "open"],
    queryFn: () => fetchFollowUp("open"),
  });
  const closedQuery = useQuery({
    queryKey: ["follow-up", "closed"],
    queryFn: () => fetchFollowUp("closed"),
  });
  const countsQuery = useQuery({
    queryKey: ["follow-up-counts"],
    queryFn: fetchFollowUpCounts,
  });
  const queryClient = useQueryClient();
  const closeMutation = useMutation({
    mutationFn: async ({
      target,
      action,
    }: {
      target: CloseTarget;
      action: "close" | "reopen";
    }) => {
      if (target.kind === "return") {
        const run = action === "close" ? archiveVehicleReturn : unarchiveVehicleReturn;
        await Promise.all(target.returnIds.map((returnId) => run(returnId)));
        return;
      }
      await setFollowUpClosed(action, {
        section: target.section,
        conversationId: target.conversationId,
        anchor: target.anchor,
      });
    },
    onSuccess: async () => {
      // Queue, archive and counts together: archiving moves an entry from one
      // list to the other, and the badge on every screen reads the same
      // numbers. Both lists sit under the `follow-up` prefix, so one
      // invalidation covers them.
      await queryClient.invalidateQueries({ queryKey: ["follow-up"] });
      await queryClient.invalidateQueries({ queryKey: ["follow-up-counts"] });
    },
    onError: async (error, variables) => {
      // Refused because a newer service replaced the return (owner rulings,
      // 2026-09-25): the lists are stale — that return is no longer archived —
      // so re-read them, and the message below says why it cannot come back.
      if (variables.action === "reopen" && isReturnReplaced(error)) {
        await queryClient.invalidateQueries({ queryKey: ["follow-up"] });
        await queryClient.invalidateQueries({ queryKey: ["follow-up-counts"] });
      }
    },
  });
  const returnReplaced =
    closeMutation.isError &&
    closeMutation.variables?.action === "reopen" &&
    isReturnReplaced(closeMutation.error);
  // Subscribed rather than read once: the title must follow a unit change.
  const currentUnitId = useAuthSession((s) => s.currentUnitId);
  const unitsQuery = useQuery({ queryKey: ["units"], queryFn: fetchUnits });
  // Named only when the id actually matches a unit the caller holds. The id is
  // resolved once at sign-in and held for the session, so it outlives access
  // being withdrawn mid-session — and a confidently wrong unit name is worse
  // than no unit name. The contract makes `name` required, so there is never an
  // identifier to fall back to.
  //
  // The fallback covers what resolution leaves open, which is no longer the
  // normal case: `AppProviders` resolves `currentUnitId` from the caller's own
  // memberships at sign-in, so the match above usually lands. It stays null
  // when that read of `GET /auth/me` failed or hit its deadline, or when the
  // caller holds no memberships at all. When the caller holds exactly ONE unit,
  // that unit is the one every request is scoped to whatever the header says —
  // the API resolves an absent `x-unit-id` against the caller's own memberships
  // — so naming it is not a guess. With several units and no id the chip stays
  // absent, because the page then genuinely cannot tell which queue it is
  // showing, and a wrong name is worse than none.
  const units = unitsQuery.data;
  const unitName =
    units?.find((unit) => unit.id === currentUnitId)?.name ??
    (currentUnitId === null && units?.length === 1 ? (units[0]?.name ?? null) : null);
  const [selected, setSelected] = useState<SectionKey | null>(null);
  // Per section, because the strip belongs to the queue it explains: opening
  // one section's archive leaves the other three showing their queues.
  const [archivedOpen, setArchivedOpen] = useState<
    Partial<Record<SectionKey, boolean>>
  >({});
  const now = new Date();
  const data = listsQuery.data;
  // The counts read owns the numbers; the list payload still carries them, so
  // it stands in when the counts read is the one that failed. Both are the same
  // server-side aggregation, so the two sources cannot contradict each other.
  const counts = countsQuery.data ?? data?.counts;

  const visible = SECTIONS.filter((section) =>
    selected ? section.key === selected : !section.onDemand,
  );

  const act = (target: CloseTarget, action: "close" | "reopen") =>
    closeMutation.mutate({ target, action });

  const titleAside = unitName ? <Chip size="small" label={unitName} /> : null;

  if (listsQuery.isLoading) {
    return (
      <PageShell current="/follow-up" title="Follow-up" titleAside={titleAside}>
        {counts ? (
          // The counts read landed first. Drawing skeletons over numbers we
          // already hold would hide known work behind a slower read.
          <CountCards counts={counts} selected={selected} onSelect={setSelected} />
        ) : (
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{ flexWrap: "wrap" }}
            role="status"
          >
            {SECTIONS.map((section) => (
              <Box key={section.key} sx={{ ...cardSx, minWidth: 180, flex: 1 }}>
                <Skeleton width="70%" />
                <Skeleton width="30%" height={36} />
              </Box>
            ))}
          </Stack>
        )}
        {visible.map((section) => (
          <PageSection
            key={section.key}
            title={section.title}
            subtitle={orderingSubtitle(section.key, undefined)}
          >
            <Box sx={cardSx}>
              <Skeleton />
              <Typography>Carregando follow-up</Typography>
            </Box>
          </PageSection>
        ))}
      </PageShell>
    );
  }

  return (
    <PageShell current="/follow-up" title="Follow-up" titleAside={titleAside}>
      <CountCards counts={counts} selected={selected} onSelect={setSelected} />

      {returnReplaced ? (
        <Alert severity="info">
          Este carro já tem um retorno aberto, e este não pode voltar para a fila.
        </Alert>
      ) : closeMutation.isError ? (
        <Alert severity="error">Não foi possível atualizar esta entrada</Alert>
      ) : null}

      {selected ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography sx={{ fontSize: TYPE_SCALE.body }} color="text.secondary">
            Mostrando apenas{" "}
            {SECTIONS.find((section) => section.key === selected)?.title}.
          </Typography>
          <Button size="small" onClick={() => setSelected(null)}>
            Ver todas as seções
          </Button>
        </Stack>
      ) : null}

      {listsQuery.isError || !data ? (
        // One message for one failure. The branch this replaced drew a
        // screen-level alert AND a per-section alert inside every rendered
        // section, so a single failed read said the same thing four or five
        // times over. The count cards above stay rendered, so the screen still
        // reports how much work is waiting even while none of it can be listed.
        <Stack spacing={1}>
          <Alert severity="error">
            Não foi possível carregar as seções do follow-up
          </Alert>
          <Box>
            <Button
              variant="contained"
              onClick={() => {
                void listsQuery.refetch();
                void countsQuery.refetch();
              }}
            >
              Tentar de novo
            </Button>
          </Box>
        </Stack>
      ) : (
        visible.map((section) => {
          const archived = archivedSummary(section.key, closedQuery.data);
          const open = archivedOpen[section.key] === true;
          return (
            <PageSection
              key={section.key}
              id={section.key}
              title={section.title}
              subtitle={orderingSubtitle(section.key, data)}
            >
              <Box sx={cardSx}>
                <SectionBody
                  sectionKey={section.key}
                  empty={open ? "Nada arquivado nesta seção." : section.empty}
                  data={open ? (closedQuery.data ?? data) : data}
                  now={now}
                  onClose={act}
                  archivedView={open}
                  busy={closeMutation.isPending}
                />
                {open ? (
                  <Box sx={{ mt: 1 }}>
                    <Button
                      {...ROW_ACTION}
                      onClick={() =>
                        setArchivedOpen((state) => ({ ...state, [section.key]: false }))
                      }
                    >
                      Voltar para a fila
                    </Button>
                  </Box>
                ) : null}
                {/* A suppressed queue nobody can look at is a queue nobody can
                    audit. A section with nothing archived draws no strip. */}
                {!open && archived.count > 0 ? (
                  <ArchivedStrip
                    count={archived.count}
                    names={archived.names}
                    onOpen={() =>
                      setArchivedOpen((state) => ({ ...state, [section.key]: true }))
                    }
                  />
                ) : null}
              </Box>
            </PageSection>
          );
        })
      )}
    </PageShell>
  );
}

/**
 * The four counts, each a toggle that filters the screen to its own section.
 *
 * @param counts - Counts held right now; a field is absent when unknown.
 * @param selected - The section filtered to, or null for the default view.
 * @param onSelect - Receives the new selection; the selected card clears it.
 * @returns One card per section, in the approved order.
 */
function CountCards({
  counts,
  selected,
  onSelect,
}: {
  counts: FollowUpOptionalCounts | undefined;
  selected: SectionKey | null;
  onSelect: (next: SectionKey | null) => void;
}) {
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
      {SECTIONS.map((section) => {
        const count = counts?.[section.key];
        const isSelected = selected === section.key;
        return (
          <Box
            key={section.key}
            component="button"
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(isSelected ? null : section.key)}
            sx={{
              ...cardSx,
              minWidth: 180,
              flex: 1,
              textAlign: "left",
              font: "inherit",
              cursor: "pointer",
              // Transparent rather than absent, so selecting a card does not
              // shift every card beside it by a pixel.
              border: 1,
              borderColor: isSelected ? "text.primary" : "transparent",
            }}
          >
            <Typography
              component="span"
              color="text.secondary"
              sx={{
                display: "block",
                fontSize: TYPE_SCALE.caption,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {section.title}
            </Typography>
            <Typography
              component="span"
              sx={{
                display: "block",
                fontSize: TYPE_SCALE.metric,
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
            >
              {/* Absent is not zero: a zero reads as "nothing pending" at the
                  moment nothing is known. */}
              {count ?? "—"}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * The rows of one section, or its Portuguese empty copy.
 *
 * @param sectionKey - Which section to render.
 * @param empty - Copy shown when the section has no entries.
 * @param data - The result to list: the queue, or the archived set while
 *   `archivedView` is true.
 * @param now - The clock the elapsed-time captions are measured against.
 * @param onClose - Archives or unarchives one entry.
 * @param archivedView - True while the archived entries are the ones listed.
 * @param busy - True while an archive or unarchive is in flight.
 * @returns The section's rows, each leading with its elapsed time.
 */
function SectionBody({
  sectionKey,
  empty,
  data,
  now,
  onClose,
  archivedView,
  busy,
}: {
  sectionKey: SectionKey;
  empty: string;
  data: FollowUpResult;
  now: Date;
  onClose: (target: CloseTarget, action: "close" | "reopen") => void;
  archivedView: boolean;
  busy: boolean;
}) {
  const divider = <Box sx={{ borderBottom: 1, borderColor: "divider" }} />;
  const action = archivedView ? "reopen" : "close";

  if (sectionKey === "unansweredQuotes") {
    const rows = data.unansweredQuotes;
    return rows.length === 0 ? (
      <EmptyState>{empty}</EmptyState>
    ) : (
      <Stack divider={divider}>
        {rows.map((row) => (
          <Stack
            key={row.quoteId}
            direction="row"
            spacing={1.5}
            useFlexGap
            sx={{ py: 1, alignItems: "center", flexWrap: "wrap" }}
          >
            <Stack>
              {/* Opens the thread on the quote itself. An id the thread does not
                  hold matches no bubble, which is the normal position. */}
              <Link
                component={RouterLink}
                to={conversationHref(row.conversationId, row.quoteMessageId)}
                underline="hover"
              >
                {`${row.label} · ${days(daysSince(row.quoteSentAt, now))} sem resposta`}
              </Link>
              <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
                orçamento enviado {formatDay(row.quoteSentAt)}
              </Typography>
            </Stack>
            <EntryActions
              archivedView={archivedView}
              busy={busy}
              href={conversationHref(row.conversationId, row.quoteMessageId)}
              archiveLabel="Arquivar esta pendência"
              onAct={() =>
                onClose(
                  {
                    kind: "entry",
                    section: "unansweredQuotes",
                    conversationId: row.conversationId,
                    // The quote id is the anchor: a newer quote in this
                    // conversation is a different one, so the entry comes back
                    // on its own rather than staying hidden.
                    anchor: row.quoteId,
                  },
                  action,
                )
              }
            />
          </Stack>
        ))}
      </Stack>
    );
  }

  if (sectionKey === "waitingReply") {
    const rows = data.waitingReply;
    return rows.length === 0 ? (
      <EmptyState>{empty}</EmptyState>
    ) : (
      <Stack divider={divider}>
        {rows.map((row) => (
          <Stack
            key={row.conversationId}
            direction="row"
            spacing={1.5}
            useFlexGap
            sx={{ py: 1, alignItems: "center", flexWrap: "wrap" }}
          >
            <Stack>
              <Link
                component={RouterLink}
                to={conversationHref(row.conversationId)}
                underline="hover"
              >
                {`${row.label} · ${days(daysSince(row.oldestPendingAt, now))} aguardando`}
              </Link>
              <Typography sx={{ fontSize: TYPE_SCALE.caption }} color="text.secondary">
                pendente desde {formatDay(row.oldestPendingAt)}
              </Typography>
            </Stack>
            <EntryActions
              archivedView={archivedView}
              busy={busy}
              href={conversationHref(row.conversationId)}
              archiveLabel="Arquivar esta pendência"
              onAct={() =>
                onClose(
                  {
                    kind: "entry",
                    section: "waitingReply",
                    conversationId: row.conversationId,
                    // The pending instant is the anchor, so a newer unanswered
                    // inbound puts the entry back.
                    anchor: row.oldestPendingAt,
                  },
                  action,
                )
              }
            />
          </Stack>
        ))}
      </Stack>
    );
  }

  if (sectionKey === "overdueReturns") {
    const rows = data.overdueReturns;
    return rows.length === 0 ? (
      <EmptyState>{empty}</EmptyState>
    ) : (
      <Stack divider={divider}>
        {rows.map((row) => (
          // One entry per customer: the action here is one message to one
          // person about every late car of theirs.
          <Stack key={row.customerId} sx={{ py: 1 }}>
            <Stack
              direction="row"
              spacing={1.5}
              useFlexGap
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              {row.conversationId ? (
                <Link
                  component={RouterLink}
                  to={conversationHref(row.conversationId)}
                  underline="hover"
                >
                  {row.label}
                </Link>
              ) : (
                <Typography component="span">{row.label}</Typography>
              )}
              {/* Only where there is a thread to open: a control named "Abrir
                  conversa" that lands on the inbox root has told the reader
                  something untrue. */}
              {row.conversationId && !archivedView ? (
                <Button
                  {...ROW_ACTION}
                  component={RouterLink}
                  to={conversationHref(row.conversationId)}
                >
                  Abrir conversa
                </Button>
              ) : null}
              {archivedView ? null : (
                <ArchiveMark
                  label={OVERDUE_ARCHIVE_LABEL}
                  disabled={busy}
                  onClick={() =>
                    onClose(
                      {
                        kind: "return",
                        returnIds: row.vehicles.map((vehicle) => vehicle.returnId),
                      },
                      "close",
                    )
                  }
                />
              )}
            </Stack>
            {row.vehicles.map((vehicle) => (
              <VehicleRow
                key={vehicle.returnId}
                vehicle={vehicle}
                customerName={row.label}
                conversationId={row.conversationId}
                now={now}
                onClose={onClose}
                archivedView={archivedView}
                busy={busy}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    );
  }

  const rows = data.upcomingReturns;
  return rows.length === 0 ? (
    <EmptyState>{empty}</EmptyState>
  ) : (
    <Stack divider={divider}>
      {rows.map((row) => (
        // One row per customer-vehicle pair, in imminence order. Grouping these
        // by customer would destroy the only ordering the section is read for.
        // The pair is named once: the customer leads the row and the car is the
        // caption under them. The head row this replaced printed
        // "Name · Car" and then handed the same car to the vehicle line, so
        // every row said the vehicle twice.
        <Stack key={row.vehicle.returnId} sx={{ py: 1 }}>
          <VehicleRow
            vehicle={row.vehicle}
            customerName={row.label}
            conversationId={row.conversationId}
            now={now}
            onClose={onClose}
            archivedView={archivedView}
            busy={busy}
            lead={
              <PairLead
                name={row.label}
                vehicle={row.vehicle}
                conversationId={row.conversationId}
              />
            }
            openConversation
          />
        </Stack>
      ))}
    </Stack>
  );
}
