/**
 * Contact rail composer: cadastro, then vehicles / quote / schedule / prefill children.
 */
import Alert from "@mui/material/Alert";
import Badge from "@mui/material/Badge";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  ConversationSummary,
  Customer,
  CustomerFieldEdit,
  PendingResolveBody,
  PrefillAcceptBody,
  PrefillFieldKey,
  Service,
  Vehicle,
  VehicleCreateBody,
  VehicleFieldEdit,
} from "@select-lub/shared-types";
import {
  acceptAllPrefill,
  acceptPrefillField,
  addConversationVehicle,
  applyConversationTag,
  createConversationCustomer,
  fetchChannelStatus,
  fetchConversationCustomer,
  fetchConversationServices,
  fetchConversationVehicles,
  fetchPrefill,
  fetchScheduledMessages,
  fetchTagApplyOptions,
  patchCustomer,
  patchPrefillExtractEnabled,
  patchVehicle,
  rejectPrefillField,
  removeConversationTag,
  resolveCustomerPending,
  retryPrefill,
} from "../api.js";
import { tagChipSx } from "../tagChip.js";
import {
  PERSON_FIELDS,
  acceptBodyFor,
  conversasContactLabel,
  joinDot,
  serviceHasNonCancelledSchedule,
  sortServicesRecentFirst,
} from "./helpers.js";
import { ScheduledMessageDrillIn, ServiceDrillIn } from "./drill-ins.js";
import {
  FieldSuggestion,
  PendingFieldActions,
  PrefillRail,
  SuggestedVehicleRow,
} from "./prefill.js";
import { OilQuoteDialog } from "./quote.js";
import {
  ScheduleMessageDialog,
  ScheduledRailRow,
  ServiceRailRow,
  sortSchedulesBySendOrder,
  sortSchedulesNewestFirst,
} from "./schedule.js";
import { AddVehicleDialog, VehicleDrillIn, VehicleRailRow } from "./vehicles.js";

/**
 * Prefill keys that describe a CAR rather than the person, in the order the
 * ghost row reads them.
 */
const VEHICLE_PREFILL_KEYS = [
  "make",
  "model",
  "version",
  "year",
  "odometerKm",
  "plate",
] as const;

function emptyCadastroDraft(phone: string) {
  return {
    name: "",
    taxId: "",
    primaryPhone: phone,
    primaryEmail: "",
    street: "",
    streetNumber: "",
    neighborhood: "",
    complement: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
  };
}

/**
 * Copies saved customer fields into the rail edit draft.
 * @param customer - Linked customer from GET conversation customer.
 * @param fallbackPhone - Conversation phone used when the customer has no primary phone.
 */
function draftFromCustomer(customer: Customer, fallbackPhone: string) {
  const phone =
    customer.phones?.find((row) => row.isPrimary)?.raw ??
    customer.phones?.[0]?.raw ??
    fallbackPhone;
  const email =
    customer.emails?.find((row) => row.isPrimary)?.raw ??
    customer.emails?.[0]?.raw ??
    "";
  return {
    name: customer.name ?? "",
    taxId: customer.taxId ?? "",
    primaryPhone: phone,
    primaryEmail: email,
    street: customer.street ?? "",
    streetNumber: customer.streetNumber ?? "",
    neighborhood: customer.neighborhood ?? "",
    complement: customer.complement ?? "",
    city: customer.city ?? "",
    state: customer.state ?? "",
    postalCode: customer.postalCode ?? "",
    country: customer.country ?? "",
  };
}

/**
 * Builds a PATCH/POST body from the rail draft. Empty optional strings become null; empty name/phone/email are omitted.
 * @param draft - Current edit-form values.
 */
function patchFromDraft(
  draft: ReturnType<typeof emptyCadastroDraft>,
): CustomerFieldEdit {
  return {
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    taxId: draft.taxId.trim() ? draft.taxId.trim() : null,
    ...(draft.primaryPhone.trim() ? { primaryPhone: draft.primaryPhone.trim() } : {}),
    ...(draft.primaryEmail.trim() ? { primaryEmail: draft.primaryEmail.trim() } : {}),
    street: draft.street.trim() ? draft.street.trim() : null,
    streetNumber: draft.streetNumber.trim() ? draft.streetNumber.trim() : null,
    neighborhood: draft.neighborhood.trim() ? draft.neighborhood.trim() : null,
    complement: draft.complement.trim() ? draft.complement.trim() : null,
    city: draft.city.trim() ? draft.city.trim() : null,
    state: draft.state.trim() ? draft.state.trim() : null,
    postalCode: draft.postalCode.trim() ? draft.postalCode.trim() : null,
    country: draft.country.trim() ? draft.country.trim() : null,
  };
}

export function ContactRail({
  conversation,
  onQuoteConfirmed,
}: {
  conversation: ConversationSummary | null;
  onQuoteConfirmed: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editingContato, setEditingContato] = useState(false);
  const [omieUnavailable, setOmieUnavailable] = useState(false);
  const [draft, setDraft] = useState(() =>
    emptyCadastroDraft(conversation?.phone ?? ""),
  );
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  // One rail, six views. A detail is a VIEW and not a dialog so the inbox and
  // the thread stay on screen while it is read; `drillReturnView` remembers
  // which list opened the detail, so Voltar goes back where the attendant came
  // from rather than always to the stack.
  const [railView, setRailView] = useState<
    | "stack"
    | "servicosFull"
    | "programadasFull"
    | "servicoDetail"
    | "programadaDetail"
    | "veiculo"
  >("stack");
  const [drillReturnView, setDrillReturnView] = useState<
    "stack" | "servicosFull" | "programadasFull"
  >("stack");
  const [drillServiceId, setDrillServiceId] = useState<string | null>(null);
  const [drillScheduleId, setDrillScheduleId] = useState<string | null>(null);
  const [drillVehicle, setDrillVehicle] = useState<Vehicle | null>(null);
  const [addVehicleOpen, setAddVehicleOpen] = useState(false);
  const [quoteVehicle, setQuoteVehicle] = useState<Vehicle | null>(null);
  const [scheduleService, setScheduleService] = useState<Service | null>(null);
  const [confirmarTudo, setConfirmarTudo] = useState(false);
  const [editAccepted, setEditAccepted] = useState<PrefillFieldKey[]>([]);
  const vehiclesQuery = useQuery({
    queryKey: ["conversation-vehicles", conversation?.id],
    queryFn: () => fetchConversationVehicles(conversation!.id),
    enabled: Boolean(conversation),
    refetchInterval: 3_000,
  });
  const customerQuery = useQuery({
    queryKey: ["conversation-customer", conversation?.id],
    queryFn: () => fetchConversationCustomer(conversation!.id),
    enabled: Boolean(conversation),
    refetchInterval: 3_000,
  });
  const servicesQuery = useQuery({
    queryKey: ["conversation-services", conversation?.id],
    queryFn: () => fetchConversationServices(conversation!.id),
    enabled: Boolean(conversation),
    refetchInterval: 3_000,
  });
  const scheduledQuery = useQuery({
    queryKey: ["scheduled-messages", conversation?.id],
    queryFn: () => fetchScheduledMessages(conversation!.id),
    enabled: Boolean(conversation),
  });
  const prefillQuery = useQuery({
    queryKey: ["conversation-prefill", conversation?.id],
    queryFn: () => fetchPrefill(conversation!.id),
    enabled: Boolean(conversation),
    refetchInterval: 3_000,
  });
  const channelQuery = useQuery({
    queryKey: ["channel-status"],
    queryFn: fetchChannelStatus,
    refetchInterval: 3_000,
  });
  const addVehicle = useMutation({
    mutationFn: (body: VehicleCreateBody) =>
      addConversationVehicle(conversation!.id, body),
    onSuccess: () => {
      setAddVehicleOpen(false);
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
    },
  });
  const saveCadastro = useMutation({
    mutationFn: (patch: CustomerFieldEdit) => {
      const customer = customerQuery.data?.customer;
      if (customer) {
        return patchCustomer(customer.id, patch);
      }
      return createConversationCustomer(conversation!.id, patch);
    },
    onSuccess: (result) => {
      setOmieUnavailable(result.omieUnavailable);
      setEditingContato(false);
      void queryClient.invalidateQueries({
        queryKey: ["conversation-customer", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-pendings"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const resolvePending = useMutation({
    mutationFn: (body: PendingResolveBody) =>
      resolveCustomerPending(customerQuery.data!.customer!.id, body),
    onSuccess: (result) => {
      setOmieUnavailable(result.omieUnavailable);
      void queryClient.invalidateQueries({
        queryKey: ["conversation-customer", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["reconciliation-pendings"] });
    },
  });
  const saveVehicle = useMutation({
    mutationFn: (input: { id: string; patch: VehicleFieldEdit }) =>
      patchVehicle(input.id, input.patch),
    onSuccess: (result) => {
      setOmieUnavailable(result.omieUnavailable);
      setEditingVehicleId(null);
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-customer", conversation?.id],
      });
    },
  });
  const acceptPrefill = useMutation({
    mutationFn: (body: PrefillAcceptBody) => acceptPrefillField(conversation!.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation-prefill", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-customer", conversation?.id],
      });
    },
  });
  const acceptAllPending = useMutation({
    mutationFn: () => acceptAllPrefill(conversation!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation-prefill", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-vehicles", conversation?.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["conversation-customer", conversation?.id],
      });
    },
  });
  const rejectPrefill = useMutation({
    mutationFn: (field: PrefillFieldKey) => rejectPrefillField(conversation!.id, field),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation-prefill", conversation?.id],
      });
    },
  });
  const retryPrefillMutation = useMutation({
    mutationFn: () => retryPrefill(conversation!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation-prefill", conversation?.id],
      });
    },
  });
  const extractEnabledMutation = useMutation({
    mutationFn: (extractEnabled: boolean) =>
      patchPrefillExtractEnabled(conversation!.id, extractEnabled),
    onMutate: async (extractEnabled) => {
      const queryKey = ["conversation-prefill", conversation?.id];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) =>
        current && typeof current === "object"
          ? { ...current, extractEnabled }
          : current,
      );
      return { previous, queryKey };
    },
    onError: (_error, _extractEnabled, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["conversation-prefill", conversation?.id],
      });
    },
  });
  const applyOptionsQuery = useQuery({
    queryKey: ["tags", "apply-options"],
    queryFn: fetchTagApplyOptions,
    enabled: Boolean(conversation),
  });
  const applyTag = useMutation({
    mutationFn: (tagId: string) => applyConversationTag(conversation!.id, tagId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
  const removeTag = useMutation({
    mutationFn: (tagId: string) => removeConversationTag(conversation!.id, tagId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  useEffect(() => {
    setEditingContato(false);
    setOmieUnavailable(false);
    setEditingVehicleId(null);
    setRailView("stack");
    setDrillReturnView("stack");
    setDrillServiceId(null);
    setDrillScheduleId(null);
    setDrillVehicle(null);
    setAddVehicleOpen(false);
    setQuoteVehicle(null);
    setScheduleService(null);
    setConfirmarTudo(false);
    setEditAccepted([]);
    setDraft(emptyCadastroDraft(conversation?.phone ?? ""));
    extractEnabledMutation.reset();
  }, [conversation?.id, conversation?.phone, extractEnabledMutation.reset]);

  if (!conversation) {
    return null;
  }

  const customer = customerQuery.data?.customer ?? null;
  const pendings = customerQuery.data?.pendings ?? [];
  const personPendings = pendings.filter((row) => row.vehicleId == null);
  const vehicles = vehiclesQuery.data?.vehicles ?? [];
  const sortedServices = sortServicesRecentFirst(servicesQuery.data?.services ?? []);
  const schedules = scheduledQuery.data ?? [];
  const previewServices = sortedServices.slice(0, 2);
  const showVerTudoServicos = sortedServices.length > 2;
  // Two orders, on purpose: the preview answers "what did I just create", the
  // Ver tudo list answers "what goes out next" (design D3a).
  const previewSchedules = sortSchedulesNewestFirst(schedules).slice(0, 2);
  const showVerTudoProgramadas = schedules.length > 2;
  const pendingFields =
    prefillQuery.data?.status === "pending" ? (prefillQuery.data.fields ?? {}) : {};
  const pendingCount = Object.keys(pendingFields).length;
  const prefillBusy =
    acceptPrefill.isPending || acceptAllPending.isPending || rejectPrefill.isPending;
  // A suggested vehicle is whatever vehicle-shaped keys the extraction
  // produced. There is no suggested REMOVAL: the prefill contract carries
  // field values only, so the rail does not draw one (deferred with the
  // coordinator, 2026-09-05).
  const suggestedVehicleKeys = VEHICLE_PREFILL_KEYS.filter(
    (key) => pendingFields[key] !== undefined,
  );
  const suggestedVehicleIdentity = joinDot([
    [pendingFields.make, pendingFields.model, pendingFields.year]
      .filter((part) => part !== undefined && String(part).trim() !== "")
      .join(" "),
    pendingFields.plate,
  ]);
  const channelConnected = channelQuery.data?.state === "CONNECTED";
  const scheduleDialog = scheduleService ? (
    <ScheduleMessageDialog
      conversationId={conversation.id}
      customerName={conversasContactLabel(customer?.name, conversation.contactLabel)}
      service={scheduleService}
      connected={channelConnected}
      scheduleBlocked={
        scheduleService
          ? serviceHasNonCancelledSchedule(schedules, scheduleService.id)
          : false
      }
      onClose={() => setScheduleService(null)}
    />
  ) : null;
  const addVehicleDialog = addVehicleOpen ? (
    <AddVehicleDialog
      customerName={conversasContactLabel(customer?.name, conversation.contactLabel)}
      busy={addVehicle.isPending}
      failed={addVehicle.isError}
      onSave={(body) => addVehicle.mutate(body)}
      onClose={() => setAddVehicleOpen(false)}
    />
  ) : null;
  const quoteDialog = quoteVehicle ? (
    <OilQuoteDialog
      vehicle={quoteVehicle}
      conversationId={conversation.id}
      onClose={() => setQuoteVehicle(null)}
      onConfirmed={(text) => {
        onQuoteConfirmed(text);
        setQuoteVehicle(null);
      }}
      onCorrectVersion={() => {
        // D24: the dialog closes and the Veículo drill-in opens on the vehicle's form.
        setQuoteVehicle(null);
        setDrillVehicle(quoteVehicle);
        setEditingVehicleId(quoteVehicle.id);
        setRailView("veiculo");
      }}
    />
  ) : null;

  const openServiceDrillIn = (serviceId: string, from: "stack" | "servicosFull") => {
    setDrillServiceId(serviceId);
    setDrillReturnView(from);
    setRailView("servicoDetail");
  };
  const openScheduleDrillIn = (
    scheduleId: string,
    from: "stack" | "programadasFull",
  ) => {
    setDrillScheduleId(scheduleId);
    setDrillReturnView(from);
    setRailView("programadaDetail");
  };

  if (railView === "servicoDetail" && drillServiceId) {
    return (
      <>
        {scheduleDialog}
        {quoteDialog}
        {addVehicleDialog}
        <ServiceDrillIn
          serviceId={drillServiceId}
          onBack={() => {
            setRailView(
              drillReturnView === "programadasFull" ? "stack" : drillReturnView,
            );
            setDrillServiceId(null);
          }}
          onProgramar={(service) => setScheduleService(service)}
        />
      </>
    );
  }

  if (railView === "programadaDetail" && drillScheduleId) {
    return (
      <>
        {scheduleDialog}
        {quoteDialog}
        {addVehicleDialog}
        <ScheduledMessageDrillIn
          scheduleId={drillScheduleId}
          conversationId={conversation.id}
          connected={channelConnected}
          onBack={() => {
            setRailView(drillReturnView === "servicosFull" ? "stack" : drillReturnView);
            setDrillScheduleId(null);
          }}
        />
      </>
    );
  }

  if (railView === "programadasFull") {
    return (
      <>
        {scheduleDialog}
        {quoteDialog}
        {addVehicleDialog}
        <Stack spacing={2} component="section" aria-label="Mensagens programadas">
          <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Button size="small" onClick={() => setRailView("stack")}>
              ← Voltar
            </Button>
            <Typography variant="subtitle1">Mensagens programadas</Typography>
          </Stack>
          {sortSchedulesBySendOrder(schedules).map((row) => (
            <ScheduledRailRow
              key={row.id}
              row={row}
              onOpenDrillIn={() => openScheduleDrillIn(row.id, "programadasFull")}
            />
          ))}
        </Stack>
      </>
    );
  }

  if (railView === "veiculo" && drillVehicle) {
    return (
      <>
        {scheduleDialog}
        {quoteDialog}
        {addVehicleDialog}
        <VehicleDrillIn
          vehicle={drillVehicle}
          vehicles={vehicles}
          onBack={() => {
            if (editingVehicleId === drillVehicle.id) setEditingVehicleId(null);
            setRailView("stack");
            setDrillVehicle(null);
          }}
          {...(editingVehicleId === drillVehicle.id
            ? {
                edit: {
                  busy: saveVehicle.isPending,
                  onSave: (patch: VehicleFieldEdit) => saveVehicle.mutate({ id: drillVehicle.id, patch }),
                },
              }
            : {})}
        />
      </>
    );
  }

  if (railView === "servicosFull") {
    return (
      <>
        {scheduleDialog}
        {quoteDialog}
        {addVehicleDialog}
        <Stack spacing={2} component="section" aria-label="Serviços">
          <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Button size="small" onClick={() => setRailView("stack")}>
              ← Voltar
            </Button>
            <Typography variant="subtitle1">Serviços</Typography>
          </Stack>
          {sortedServices.map((service) => (
            <ServiceRailRow
              key={service.id}
              service={service}
              vehicle={vehicles.find((row) => row.id === service.vehicleId)}
              showOdometer
              onProgramar={() => setScheduleService(service)}
              onOpenDrillIn={() => openServiceDrillIn(service.id, "servicosFull")}
              scheduleBlocked={serviceHasNonCancelledSchedule(schedules, service.id)}
            />
          ))}
        </Stack>
      </>
    );
  }

  return (
    <>
      {scheduleDialog}
      {quoteDialog}
      {addVehicleDialog}
      <Stack spacing={2}>
        <Stack
          direction="row"
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="subtitle1">Contato</Typography>
          {customerQuery.isLoading || customerQuery.isError ? null : editingContato ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              {pendingCount > 0 ? (
                <Button
                  size="small"
                  onClick={() => {
                    setConfirmarTudo(true);
                    const next = { ...draft };
                    if (pendingFields.name) {
                      next.name = pendingFields.name;
                    }
                    if (pendingFields.taxId) {
                      next.taxId = pendingFields.taxId;
                    }
                    setDraft(next);
                  }}
                >
                  Confirmar tudo
                </Button>
              ) : null}
              <Button
                variant="contained"
                data-testid="conversas-cadastro-save"
                disabled={
                  saveCadastro.isPending ||
                  acceptAllPending.isPending ||
                  acceptPrefill.isPending
                }
                onClick={() => {
                  void (async () => {
                    try {
                      await saveCadastro.mutateAsync(patchFromDraft(draft));
                      if (confirmarTudo) {
                        await acceptAllPending.mutateAsync();
                        setConfirmarTudo(false);
                        setEditAccepted([]);
                        return;
                      }
                      for (const field of editAccepted) {
                        const value = pendingFields[field];
                        if (value === undefined) {
                          continue;
                        }
                        await acceptPrefill.mutateAsync(acceptBodyFor(field, value));
                      }
                      setEditAccepted([]);
                    } catch {
                      /* saveCadastro / accept errors surface via mutation isError */
                    }
                  })();
                }}
              >
                Salvar
              </Button>
            </Stack>
          ) : (
            <Badge
              badgeContent={pendingCount}
              invisible={pendingCount === 0}
              color="primary"
              onClick={() => {
                setDraft(
                  customer
                    ? draftFromCustomer(customer, conversation.phone)
                    : emptyCadastroDraft(conversation.phone),
                );
                setEditingContato(true);
                setConfirmarTudo(false);
                setEditAccepted([]);
              }}
              sx={{ cursor: pendingCount > 0 ? "pointer" : undefined }}
            >
              <Button variant="outlined" data-testid="conversas-cadastro-edit">
                Editar
              </Button>
            </Badge>
          )}
        </Stack>
        {customerQuery.isLoading ? (
          <Stack spacing={1} role="status">
            <Skeleton variant="rounded" height={48} />
            <Typography>Carregando cadastro</Typography>
          </Stack>
        ) : customerQuery.isError ? (
          <Stack spacing={1}>
            <Alert severity="error">Não foi possível carregar o cadastro</Alert>
            <Button variant="contained" onClick={() => void customerQuery.refetch()}>
              Tentar de novo
            </Button>
          </Stack>
        ) : (
          <>
            {omieUnavailable ? (
              <Alert severity="error">
                Omie indisponível. Os dados locais foram mantidos.
              </Alert>
            ) : null}
            {saveCadastro.isError && !String(saveCadastro.error).includes("409") ? (
              <Alert severity="error">Não foi possível salvar o cadastro</Alert>
            ) : null}
            {customer ? (
              <Stack spacing={0.5}>
                <Typography variant="body1">
                  {conversasContactLabel(customer.name, conversation.contactLabel)}
                </Typography>
                <Typography variant="body2">
                  {customer.phones?.find((row) => row.isPrimary)?.raw ??
                    customer.phones?.[0]?.raw ??
                    conversation.phone}
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={0.5}>
                <Typography variant="body1">{conversation.phone}</Typography>
                <Typography variant="body2">Sem cadastro vinculado</Typography>
              </Stack>
            )}
            {!editingContato && !customer ? (
              <Typography>
                Preencha o cadastro em &quot;Editar&quot; para criar e vincular o
                cliente
              </Typography>
            ) : null}
            {/* The name suggestion sits under the header, because the name IS
              the header — it has no row of its own in the list below. */}
            {!editingContato && pendingFields.name !== undefined ? (
              <FieldSuggestion
                label="Nome"
                currentValue={customer?.name ?? ""}
                suggested={pendingFields.name}
                busy={prefillBusy}
                onAccept={() =>
                  acceptPrefill.mutate(acceptBodyFor("name", pendingFields.name!))
                }
                onReject={() => rejectPrefill.mutate("name")}
              />
            ) : null}
            {!editingContato
              ? PERSON_FIELDS.filter(
                  (field) => field.key !== "name" && field.key !== "primaryPhone",
                ).map((field) => {
                  const raw =
                    field.key === "primaryEmail"
                      ? (customer?.emails?.find((row) => row.isPrimary)?.raw ??
                        customer?.emails?.[0]?.raw ??
                        "")
                      : ((customer?.[field.key as keyof Customer] as
                          string | null | undefined) ?? "");
                  const pending = personPendings.find(
                    (row) => row.fieldKey === field.key,
                  );
                  // Only taxId is both a cadastro field on this list and a
                  // key the extraction can propose.
                  const suggested =
                    field.key === "taxId" ? pendingFields.taxId : undefined;
                  if (!raw && !pending && suggested === undefined) {
                    return null;
                  }
                  return (
                    <Stack key={field.key} spacing={0.5}>
                      {raw ? (
                        <Typography variant="body2">
                          {field.label}: {raw}
                        </Typography>
                      ) : null}
                      {suggested === undefined ? null : (
                        <FieldSuggestion
                          label={field.label}
                          currentValue={raw}
                          suggested={suggested}
                          busy={prefillBusy}
                          onAccept={() =>
                            acceptPrefill.mutate(acceptBodyFor("taxId", suggested))
                          }
                          onReject={() => rejectPrefill.mutate("taxId")}
                        />
                      )}
                      {pending ? (
                        <PendingFieldActions
                          pending={pending}
                          busy={resolvePending.isPending}
                          onResolve={(body) => resolvePending.mutate(body)}
                        />
                      ) : null}
                    </Stack>
                  );
                })
              : null}
            {editingContato
              ? PERSON_FIELDS.map((field) => {
                  const pending = personPendings.find(
                    (row) => row.fieldKey === field.key,
                  );
                  const prefillKey =
                    field.key === "name" || field.key === "taxId" ? field.key : null;
                  const suggested = prefillKey ? pendingFields[prefillKey] : undefined;
                  const locallyAccepted =
                    prefillKey !== null && editAccepted.includes(prefillKey);
                  const emptyWithGhost =
                    suggested !== undefined &&
                    draft[field.key].trim() === "" &&
                    !locallyAccepted;
                  const filledCorrection =
                    suggested !== undefined &&
                    prefillKey !== null &&
                    !locallyAccepted &&
                    draft[field.key].trim() !== "" &&
                    draft[field.key] !== String(suggested);
                  const showPrefillActions =
                    prefillKey !== null && (emptyWithGhost || filledCorrection);
                  return (
                    <Stack key={field.key} spacing={0.5}>
                      <TextField
                        size="small"
                        label={field.label}
                        value={draft[field.key]}
                        placeholder={emptyWithGhost ? String(suggested) : undefined}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))
                        }
                        slotProps={
                          field.key === "name"
                            ? {
                                htmlInput: { "data-testid": "conversas-cadastro-name" },
                              }
                            : undefined
                        }
                        sx={
                          emptyWithGhost
                            ? {
                                "& .MuiInputBase-input::placeholder": {
                                  fontStyle: "italic",
                                  opacity: 0.7,
                                },
                              }
                            : undefined
                        }
                      />
                      {emptyWithGhost ? (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontStyle: "italic" }}
                        >
                          sugestão
                        </Typography>
                      ) : null}
                      {showPrefillActions && prefillKey ? (
                        <Stack spacing={0.5}>
                          {filledCorrection ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontStyle: "italic" }}
                            >
                              sugestão: {String(suggested)}
                            </Typography>
                          ) : null}
                          <Stack direction="row" spacing={1}>
                            <Button
                              size="small"
                              onClick={() => {
                                setEditAccepted((current) =>
                                  current.includes(prefillKey)
                                    ? current
                                    : [...current, prefillKey],
                                );
                                setDraft((current) => ({
                                  ...current,
                                  [field.key]: String(suggested),
                                }));
                              }}
                            >
                              Aceitar {field.label}
                            </Button>
                            <Button
                              size="small"
                              onClick={() => rejectPrefill.mutate(prefillKey)}
                            >
                              Recusar {field.label}
                            </Button>
                          </Stack>
                        </Stack>
                      ) : null}
                      {pending ? (
                        <PendingFieldActions
                          pending={pending}
                          busy={resolvePending.isPending}
                          onResolve={(body) => resolvePending.mutate(body)}
                        />
                      ) : null}
                    </Stack>
                  );
                })
              : null}
            {!editingContato
              ? personPendings
                  .filter(
                    (row) => row.fieldKey === "name" || row.fieldKey === "primaryPhone",
                  )
                  .map((pending) => (
                    <PendingFieldActions
                      key={pending.fieldKey}
                      pending={pending}
                      busy={resolvePending.isPending}
                      onResolve={(body) => resolvePending.mutate(body)}
                    />
                  ))
              : null}
          </>
        )}
        <Typography variant="subtitle2">Tags</Typography>
        {conversation.tags.length
          ? conversation.tags.map((tag) => (
              <Chip
                key={tag.id}
                label={tag.name}
                sx={tagChipSx(tag.color)}
                onDelete={() => removeTag.mutate(tag.id)}
              />
            ))
          : null}
        {applyOptionsQuery.data
          ?.filter((tag) => !conversation.tags.some((applied) => applied.id === tag.id))
          .map((tag) => (
            <Button
              key={tag.id}
              size="small"
              variant="outlined"
              disabled={applyTag.isPending}
              onClick={() => applyTag.mutate(tag.id)}
            >
              Aplicar {tag.name}
            </Button>
          ))}
        <PrefillRail
          query={prefillQuery}
          onRetry={() => retryPrefillMutation.mutate()}
          retrying={retryPrefillMutation.isPending}
        />
        <Typography variant="subtitle2">Veículos</Typography>
        {/* Outside the linked-customer branch on purpose: the extraction
          usually runs BEFORE a cadastro exists, and accepting a suggested
          vehicle is what creates the customer. Hiding the row until one is
          linked would make the suggestion unreachable in its common case. */}
        {suggestedVehicleKeys.length > 0 ? (
          <SuggestedVehicleRow
            identity={suggestedVehicleIdentity || "Veículo sugerido"}
            busy={prefillBusy}
            onAccept={() => {
              void (async () => {
                try {
                  for (const key of suggestedVehicleKeys) {
                    const value = pendingFields[key];
                    if (value !== undefined) {
                      await acceptPrefill.mutateAsync(acceptBodyFor(key, value));
                    }
                  }
                } catch {
                  /* accept errors surface via the mutation's isError */
                }
              })();
            }}
            onReject={() => {
              for (const key of suggestedVehicleKeys) {
                rejectPrefill.mutate(key);
              }
            }}
          />
        ) : null}
        {vehiclesQuery.isLoading ? (
          <Stack spacing={1} role="status">
            <Skeleton variant="rounded" height={48} />
            <Typography>Carregando veículos</Typography>
          </Stack>
        ) : vehiclesQuery.isError ? (
          <Stack spacing={1}>
            <Alert severity="error">Não foi possível carregar os veículos</Alert>
            <Button variant="contained" onClick={() => void vehiclesQuery.refetch()}>
              Tentar de novo
            </Button>
          </Stack>
        ) : vehiclesQuery.data?.customerId == null ? (
          <Typography>Nenhum cliente vinculado</Typography>
        ) : (
          <Stack spacing={1}>
            {vehiclesQuery.data.vehicles.length === 0 ? (
              <Typography>Nenhum veículo cadastrado</Typography>
            ) : (
              vehiclesQuery.data.vehicles.map((vehicle) => (
                <VehicleRailRow
                  key={vehicle.id}
                  vehicle={vehicle}
                  pendings={pendings.filter((row) => row.vehicleId === vehicle.id)}
                  editing={editingVehicleId === vehicle.id}
                  busy={saveVehicle.isPending || resolvePending.isPending}
                  onOpenDrillIn={() => {
                    setDrillVehicle(vehicle);
                    setRailView("veiculo");
                  }}
                  onMontarOrcamento={() => setQuoteVehicle(vehicle)}
                  onStartEdit={() => {
                    setEditingVehicleId(vehicle.id);
                  }}
                  onSave={(patch) => {
                    saveVehicle.mutate({
                      id: vehicle.id,
                      patch,
                    });
                  }}
                  onResolve={(body) => resolvePending.mutate(body)}
                />
              ))
            )}
            <Button variant="outlined" onClick={() => setAddVehicleOpen(true)}>
              Adicionar veículo
            </Button>
          </Stack>
        )}
        <Stack spacing={1} component="section" aria-label="Serviços">
          <Stack
            direction="row"
            sx={{ alignItems: "center", justifyContent: "space-between" }}
          >
            <Typography variant="subtitle2">Serviços</Typography>
            {showVerTudoServicos &&
            !servicesQuery.isLoading &&
            !servicesQuery.isError ? (
              <Button size="small" onClick={() => setRailView("servicosFull")}>
                Ver tudo
              </Button>
            ) : null}
          </Stack>
          {servicesQuery.isLoading ? (
            <Stack spacing={1} role="status">
              <Skeleton variant="rounded" height={48} />
              <Typography>Carregando serviços</Typography>
            </Stack>
          ) : servicesQuery.isError ? (
            <Stack spacing={1}>
              <Alert severity="error">Não foi possível carregar os serviços</Alert>
              <Button variant="contained" onClick={() => void servicesQuery.refetch()}>
                Tentar de novo
              </Button>
            </Stack>
          ) : servicesQuery.data?.customerId == null ? (
            <Typography>Nenhum cliente vinculado</Typography>
          ) : sortedServices.length === 0 ? (
            <Typography>Nenhum serviço encontrado</Typography>
          ) : (
            previewServices.map((service) => (
              <ServiceRailRow
                key={service.id}
                service={service}
                vehicle={vehicles.find((row) => row.id === service.vehicleId)}
                showOdometer={false}
                onProgramar={() => setScheduleService(service)}
                onOpenDrillIn={() => openServiceDrillIn(service.id, "stack")}
                scheduleBlocked={serviceHasNonCancelledSchedule(schedules, service.id)}
              />
            ))
          )}
        </Stack>
        <Stack spacing={1} component="section" aria-label="Mensagens programadas">
          <Stack
            direction="row"
            sx={{ alignItems: "center", justifyContent: "space-between" }}
          >
            <Typography variant="subtitle2">Mensagens programadas</Typography>
            {showVerTudoProgramadas &&
            !scheduledQuery.isLoading &&
            !scheduledQuery.isError ? (
              <Button size="small" onClick={() => setRailView("programadasFull")}>
                Ver tudo
              </Button>
            ) : null}
          </Stack>
          {scheduledQuery.isLoading ? (
            <Stack spacing={1} role="status">
              <Skeleton variant="rounded" height={48} />
              <Typography>Carregando mensagens programadas</Typography>
            </Stack>
          ) : scheduledQuery.isError ? (
            <Stack spacing={1}>
              <Alert severity="error">
                Não foi possível carregar as mensagens programadas
              </Alert>
              <Button variant="contained" onClick={() => void scheduledQuery.refetch()}>
                Tentar de novo
              </Button>
            </Stack>
          ) : servicesQuery.data?.customerId == null ? (
            // The same linked-customer signal the Serviços section reads. A
            // scheduled message hangs off the conversation's customer exactly as
            // a service does, so the two sections must not disagree about
            // whether one is linked.
            <Typography>Nenhum cliente vinculado</Typography>
          ) : schedules.length === 0 ? (
            <Typography>Nenhuma mensagem programada</Typography>
          ) : (
            previewSchedules.map((row) => (
              <ScheduledRailRow
                key={row.id}
                row={row}
                onOpenDrillIn={() => openScheduleDrillIn(row.id, "stack")}
              />
            ))
          )}
        </Stack>
        <Stack spacing={0.5} component="section" aria-label="Sugerir dados do cliente">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={prefillQuery.data?.extractEnabled ?? false}
                disabled={extractEnabledMutation.isPending || prefillQuery.isLoading}
                onChange={(event) =>
                  extractEnabledMutation.mutate(event.target.checked)
                }
              />
            }
            label="Sugerir dados do cliente"
          />
          <Typography variant="caption" color="text.secondary">
            Gasta uma chamada de IA: sugere o cadastro e marca se a conversa precisa de
            resposta.
          </Typography>
          {extractEnabledMutation.isError ? (
            <Alert severity="error">
              Não foi possível salvar a opção de sugerir dados do cliente
            </Alert>
          ) : null}
        </Stack>
      </Stack>
    </>
  );
}
