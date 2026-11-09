/**
 * Prefill rail plus the unit-wide Omie pendências drawer, which is a per-field
 * merge: each conflict shows both values with the differing run marked and its
 * own Usar CRM / Usar Omie / Editar, and nothing is pre-selected.
 */
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  ConversationSummary,
  GlobalReconciliationPending,
  PendingResolveBody,
  ReconciliationPending,
} from "@select-lub/shared-types";
import { fetchPrefill, resolveCustomerPending } from "../api.js";
import { PENDING_FIELD_LABELS } from "./helpers.js";

/**
 * Splits one side of a conflict into the part it shares with the other side
 * and the part that actually differs.
 *
 * Reading two near-identical values — `roberto.a@example.com` against
 * `roberto.aparecido@example.com` — is where a per-field merge goes wrong, so
 * the panel marks the differing run rather than asking the operator to spot it.
 *
 * @param value - The side being rendered
 * @param other - The opposing value, used only to find the shared prefix and suffix
 * @returns The shared head, the differing run, and the shared tail; `marked` is empty when the two are equal
 */
export function diffSegments(
  value: string,
  other: string,
): { prefix: string; marked: string; suffix: string } {
  let prefix = 0;
  while (
    prefix < value.length &&
    prefix < other.length &&
    value[prefix] === other[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < value.length - prefix &&
    suffix < other.length - prefix &&
    value[value.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    prefix: value.slice(0, prefix),
    marked: value.slice(prefix, value.length - suffix),
    suffix: value.slice(value.length - suffix),
  };
}

/** One side of a conflict, with the differing run marked. */
function DiffRow({
  side,
  value,
  other,
}: {
  side: string;
  value: string;
  other: string;
}) {
  const parts = diffSegments(value, other);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ width: 40, flexShrink: 0 }}
      >
        {side}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, wordBreak: "break-word" }}>
        {parts.prefix}
        <Box
          component="span"
          sx={{
            fontWeight: 700,
            bgcolor: "action.selected",
            borderRadius: 0.5,
            px: 0.25,
          }}
        >
          {parts.marked}
        </Box>
        {parts.suffix}
      </Typography>
    </Stack>
  );
}

function groupPendingsByCustomer(rows: GlobalReconciliationPending[]) {
  const groups: {
    customerId: string;
    customerName: string;
    rows: GlobalReconciliationPending[];
  }[] = [];
  for (const row of rows) {
    const existing = groups.find((group) => group.customerId === row.customerId);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.push({
        customerId: row.customerId,
        customerName: row.customerName,
        rows: [row],
      });
    }
  }
  return groups;
}

export function OmiePendenciasPanel({
  rows,
  conversations,
  onOpenConversation,
  onClose,
}: {
  rows: GlobalReconciliationPending[];
  conversations: ConversationSummary[];
  onOpenConversation: (id: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const groups = groupPendingsByCustomer(rows);
  const resolvePending = useMutation({
    mutationFn: (input: { customerId: string; body: PendingResolveBody }) =>
      resolveCustomerPending(input.customerId, input.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-pendings"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation-customer"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation-vehicles"] });
    },
  });
  return (
    <Box sx={{ width: 460, p: 2.5 }}>
      <Stack
        direction="row"
        sx={{ justifyContent: "space-between", alignItems: "center", mb: 2 }}
      >
        <Typography variant="h6">Pendências com o Omie — todos os clientes</Typography>
        <Button onClick={onClose}>Fechar</Button>
      </Stack>
      {groups.length === 0 ? (
        <Typography>Nenhuma pendência aberta</Typography>
      ) : (
        <Stack spacing={2}>
          {/* The count is of FIELDS, not customers: it is the size of the work
              left, and one customer can hold several conflicts. */}
          <Alert severity="warning" icon={false}>
            {rows.length === 1
              ? "1 campo ainda sem resolução"
              : `${rows.length} campos ainda sem resolução`}
          </Alert>
          {resolvePending.isError ? (
            <Alert severity="error">Não foi possível resolver a pendência</Alert>
          ) : null}
          {groups.map((group) => {
            const match = conversations.find(
              (row) => row.contactLabel === group.customerName,
            );
            return (
              <Stack
                key={group.customerId}
                spacing={1.5}
                sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}
              >
                <Typography variant="subtitle2">{group.customerName}</Typography>
                {group.rows.map((row) => (
                  <Stack
                    key={`${row.customerId}-${row.fieldKey}-${row.vehicleId ?? ""}`}
                    spacing={0.5}
                  >
                    <Typography variant="caption">
                      {PENDING_FIELD_LABELS[row.fieldKey]}
                    </Typography>
                    <DiffRow side="CRM" value={row.crmValue} other={row.omieValue} />
                    <DiffRow side="Omie" value={row.omieValue} other={row.crmValue} />
                    <PendingChoiceActions
                      pending={row}
                      busy={resolvePending.isPending}
                      onResolve={(body) =>
                        resolvePending.mutate({ customerId: row.customerId, body })
                      }
                    />
                  </Stack>
                ))}
                {match ? (
                  <Button size="small" onClick={() => onOpenConversation(match.id)}>
                    Abrir conversa
                  </Button>
                ) : null}
              </Stack>
            );
          })}
          <Typography variant="caption">
            O sistema não escolhe um lado automaticamente. Resolva campo a campo.
          </Typography>
        </Stack>
      )}
    </Box>
  );
}

/**
 * The three ways to settle one conflicting field, with nothing pre-selected.
 *
 * Both values are real customer data, so the system does not pick a side and
 * there is no bulk "take one side" — the operator resolves field by field.
 *
 * @param pending - The open conflict row being settled
 * @param busy - True while a resolve request is in flight
 * @param onResolve - Receives the chosen body; `edit` carries the typed value
 */
export function PendingChoiceActions({
  pending,
  busy,
  onResolve,
}: {
  pending: ReconciliationPending;
  busy: boolean;
  onResolve: (body: PendingResolveBody) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(pending.crmValue);
  return (
    <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }} useFlexGap>
      <Button
        size="small"
        disabled={busy}
        onClick={() =>
          onResolve({
            choice: "crm",
            fieldKey: pending.fieldKey,
            vehicleId: pending.vehicleId,
          })
        }
      >
        Usar CRM
      </Button>
      <Button
        size="small"
        disabled={busy}
        onClick={() =>
          onResolve({
            choice: "omie",
            fieldKey: pending.fieldKey,
            vehicleId: pending.vehicleId,
          })
        }
      >
        Usar Omie
      </Button>
      {editing ? (
        <>
          <TextField
            size="small"
            label="Novo valor"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            size="small"
            variant="contained"
            disabled={busy || value.trim() === ""}
            onClick={() =>
              onResolve({
                choice: "edit",
                fieldKey: pending.fieldKey,
                vehicleId: pending.vehicleId,
                value: value.trim(),
              })
            }
          >
            Confirmar
          </Button>
        </>
      ) : (
        <Button size="small" disabled={busy} onClick={() => setEditing(true)}>
          Editar valor
        </Button>
      )}
    </Stack>
  );
}

/**
 * One conflicting field on the Conversas rail: the warning, both values, and
 * the three choices.
 *
 * @param pending - The open conflict row being settled
 * @param busy - True while a resolve request is in flight
 * @param onResolve - Receives the chosen body
 */
export function PendingFieldActions({
  pending,
  busy,
  onResolve,
}: {
  pending: ReconciliationPending;
  busy: boolean;
  onResolve: (body: PendingResolveBody) => void;
}) {
  const label = PENDING_FIELD_LABELS[pending.fieldKey];
  return (
    <Stack spacing={0.5}>
      <Alert severity="warning">{label} tem uma pendência de conflito com o Omie</Alert>
      <Typography variant="caption">
        CRM: {pending.crmValue} · Omie: {pending.omieValue}
      </Typography>
      <PendingChoiceActions pending={pending} busy={busy} onResolve={onResolve} />
    </Stack>
  );
}

/**
 * The extraction's own state — running, or failed with a retry.
 *
 * It no longer lists the suggestions: those are rendered on the fields they
 * are about ({@link FieldSuggestion}, {@link SuggestedVehicleRow}), because a
 * separate card made the operator match a proposal to a field by eye. Once the
 * extraction has produced suggestions this renders nothing.
 *
 * @param query - The prefill read for the open conversation
 * @param onRetry - Re-runs a failed extraction. Called only when the extraction
 *   failed; when the READ failed, "Tentar de novo" reads again instead (owner
 *   rulings, 2026-09-25): queueing an extraction does not fix a read.
 * @param retrying - True while a retry request is in flight; the button is
 *   disabled so a double press cannot post a second retry.
 */
export { FieldSuggestion, SuggestedVehicleRow } from "./prefill.suggestions.js";

export function PrefillRail({
  query,
  onRetry,
  retrying = false,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchPrefill>>>>;
  onRetry: () => void;
  retrying?: boolean;
}) {
  if (query.isLoading || query.data?.status === "extracting") {
    return (
      <Stack spacing={1} role="status">
        <Skeleton variant="rounded" height={48} />
        <Typography>Extraindo cadastro</Typography>
      </Stack>
    );
  }
  if (query.isError || query.data?.status === "failed") {
    return (
      <Stack spacing={1}>
        <Alert severity="error">Não foi possível extrair o cadastro</Alert>
        <Button
          variant="contained"
          disabled={retrying || query.isFetching}
          onClick={() => (query.isError ? void query.refetch() : onRetry())}
        >
          Tentar de novo
        </Button>
      </Stack>
    );
  }
  return null;
}
