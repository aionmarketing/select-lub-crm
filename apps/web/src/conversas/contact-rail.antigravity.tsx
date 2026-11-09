/**
 * Contact rail composer: cadastro, then vehicles / quote / schedule / prefill children.
 */
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
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
import { PendingFieldActions, PrefillRail } from "./prefill.js";
import {
  FieldSuggestion,
  SuggestedVehicleRow,
} from "./prefill.suggestions.antigravity.js";
import { OilQuoteDialog } from "./quote.js";
import {
  ScheduleMessageDialog,
  ScheduledRailRow,
  ServiceRailRow,
  sortSchedulesBySendOrder,
  sortSchedulesNewestFirst,
} from "./schedule.js";
import { AddVehicleDialog, VehicleDrillIn } from "./vehicles.js";
import { VehicleRailRow } from "./vehicles.rail-row.antigravity.js";

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
      <Stack spacing={2.5}>
        {/* Contato section */}
        <Box
          component="section"
          aria-label="Contato"
          sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 700, fontSize: "14px", color: "text.primary" }}
            >
              Contato
            </Typography>
            {customerQuery.isLoading ||
            customerQuery.isError ? null : editingContato ? (
              <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                {pendingCount > 0 ? (
                  <Button
                    size="small"
                    variant="outlined"
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
                    sx={{
                      textTransform: "none",
                      fontSize: "11px",
                      px: 1,
                      py: 0.25,
                      borderRadius: 1,
                    }}
                  >
                    Confirmar tudo
                  </Button>
                ) : null}
                <Button
                  size="small"
                  onClick={() => {
                    setEditingContato(false);
                    setConfirmarTudo(false);
                    setEditAccepted([]);
                  }}
                  sx={{
                    textTransform: "none",
                    fontSize: "11px",
                    px: 1,
                    py: 0.25,
                    color: "text.secondary",
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  size="small"
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
                  sx={{
                    textTransform: "none",
                    fontSize: "11px",
                    px: 1.25,
                    py: 0.25,
                    fontWeight: 600,
                  }}
                >
                  Salvar
                </Button>
              </Stack>
            ) : (
              <Badge
                badgeContent={pendingCount}
                color="primary"
                sx={{
                  "& .MuiBadge-badge": {
                    bgcolor: "primary.main",
                    color: "onPrimary",
                    fontWeight: 700,
                    fontSize: "11px",
                    height: 18,
                    minWidth: 18,
                    right: -6,
                    top: 4,
                  },
                }}
              >
                <Button
                  size="small"
                  variant="outlined"
                  data-testid="conversas-cadastro-edit"
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
                  sx={{
                    textTransform: "none",
                    fontSize: "12px",
                    borderRadius: 999,
                    py: 0.25,
                    px: 1.5,
                    borderColor: "divider",
                    color: "text.primary",
                    lineHeight: 1.4,
                  }}
                >
                  Editar
                </Button>
              </Badge>
            )}
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar
              sx={{
                width: 46,
                height: 46,
                bgcolor: "surfaceVariant",
                color: "text.primary",
                fontWeight: 700,
                fontSize: "18px",
                flexShrink: 0,
              }}
            >
              {customer?.name ? customer.name.slice(0, 1).toUpperCase() : null}
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {customer ? (
                <>
                  <Typography
                    sx={{
                      fontWeight: 600,
                      fontSize: "15px",
                      lineHeight: 1.2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {conversasContactLabel(customer.name, conversation.contactLabel)}
                  </Typography>
                  <Typography
                    sx={{ fontSize: "12px", color: "text.secondary", mt: 0.25 }}
                  >
                    {customer.phones?.find((row) => row.isPrimary)?.raw ??
                      customer.phones?.[0]?.raw ??
                      conversation.phone}
                  </Typography>
                </>
              ) : (
                <>
                  <Typography
                    sx={{ fontWeight: 600, fontSize: "15px", lineHeight: 1.2 }}
                  >
                    {conversation.phone}
                  </Typography>
                  <Typography
                    sx={{ fontSize: "12px", color: "text.secondary", mt: 0.25 }}
                  >
                    Sem cadastro vinculado
                  </Typography>
                </>
              )}
            </Box>
          </Box>

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
              {!editingContato && !customer ? (
                <Typography sx={{ fontSize: "12px", color: "text.secondary" }}>
                  Preencha o cadastro em &quot;Editar&quot; para criar e vincular o
                  cliente
                </Typography>
              ) : null}
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
                    const suggested =
                      field.key === "taxId" ? pendingFields.taxId : undefined;
                    if (!raw && suggested === undefined && !pending) {
                      return null;
                    }
                    return (
                      <Stack key={field.key} spacing={0.5}>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 1,
                          }}
                        >
                          <Typography
                            sx={{
                              fontSize: "12px",
                              lineHeight: 1.5,
                              flex: 1,
                              minWidth: 0,
                              color: raw ? "text.primary" : "text.secondary",
                            }}
                          >
                            {field.label}: {raw}
                          </Typography>
                          {suggested !== undefined ? (
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
                          ) : null}
                        </Box>
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
                    const suggested = prefillKey
                      ? pendingFields[prefillKey]
                      : undefined;
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
                          slotProps={{
                            htmlInput: {
                              ...(field.key === "name"
                                ? {
                                    "data-testid": "conversas-cadastro-name",
                                    "aria-label": "Nome",
                                  }
                                : { "aria-label": field.label }),
                            },
                          }}
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
                      (row) =>
                        row.fieldKey === "name" || row.fieldKey === "primaryPhone",
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
        </Box>

        {/* Tags section */}
        <Box
          component="section"
          aria-label="Tags"
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: "13px", color: "text.primary" }}>
            Tags
          </Typography>
          <Box
            sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", alignItems: "center" }}
          >
            {conversation.tags.map((tag) => (
              <Chip
                key={tag.id}
                label={tag.name}
                sx={tagChipSx(tag.color)}
                onDelete={() => removeTag.mutate(tag.id)}
              />
            ))}
            {applyOptionsQuery.data
              ?.filter(
                (tag) => !conversation.tags.some((applied) => applied.id === tag.id),
              )
              .map((tag) => (
                <Button
                  key={tag.id}
                  size="small"
                  variant="outlined"
                  aria-label={`Aplicar ${tag.name}`}
                  disabled={applyTag.isPending}
                  onClick={() => applyTag.mutate(tag.id)}
                  sx={{
                    borderRadius: 999,
                    fontSize: "11px",
                    textTransform: "none",
                    borderColor: "divider",
                    color: "text.primary",
                    py: 0.25,
                    px: 1,
                    minHeight: "unset",
                    height: 24,
                  }}
                >
                  Aplicar &quot;{tag.name}&quot;
                </Button>
              ))}
          </Box>
        </Box>

        <PrefillRail
          query={prefillQuery}
          onRetry={() => retryPrefillMutation.mutate()}
          retrying={retryPrefillMutation.isPending}
        />

        {/* Veículos section */}
        <Box
          component="section"
          aria-label="Veículos"
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: "13px", color: "text.primary" }}>
            Veículos
          </Typography>
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
              <Skeleton variant="rounded" height={40} />
              <Typography sx={{ fontSize: "12px", opacity: 0.7 }}>
                Carregando veículos
              </Typography>
            </Stack>
          ) : vehiclesQuery.isError ? (
            <Stack spacing={1}>
              <Alert severity="error">Não foi possível carregar os veículos</Alert>
              <Button
                variant="contained"
                size="small"
                onClick={() => void vehiclesQuery.refetch()}
              >
                Tentar de novo
              </Button>
            </Stack>
          ) : vehiclesQuery.data?.customerId == null ? (
            <Typography
              sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
            >
              Nenhum cliente vinculado
            </Typography>
          ) : (
            <Stack spacing={1}>
              {vehiclesQuery.data.vehicles.length === 0 ? (
                <Typography
                  sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
                >
                  Nenhum veículo cadastrado
                </Typography>
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
              <Button
                variant="contained"
                color="primary"
                fullWidth
                size="small"
                onClick={() => setAddVehicleOpen(true)}
                aria-label="Adicionar veículo"
                startIcon={
                  <Box
                    component="span"
                    aria-hidden="true"
                    sx={{ fontWeight: 700, mr: -0.5 }}
                  >
                    +
                  </Box>
                }
                sx={{
                  textTransform: "none",
                  fontWeight: 600,
                  fontSize: "12px",
                  borderRadius: 999,
                  py: 0.6,
                  boxShadow: "none",
                  "&:hover": { boxShadow: "none" },
                }}
              >
                Adicionar veículo
              </Button>
            </Stack>
          )}
        </Box>

        {/* Serviços section */}
        <Box
          component="section"
          aria-label="Serviços"
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Typography
              sx={{ fontWeight: 700, fontSize: "13px", color: "text.primary" }}
            >
              Serviços
            </Typography>
            {showVerTudoServicos &&
            !servicesQuery.isLoading &&
            !servicesQuery.isError ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setRailView("servicosFull")}
                sx={{
                  textTransform: "none",
                  fontSize: "12px",
                  fontWeight: 600,
                  p: 0,
                  minWidth: "unset",
                  color: "text.secondary",
                }}
              >
                Ver tudo
              </Button>
            ) : null}
          </Box>
          {servicesQuery.isLoading ? (
            <Stack spacing={1} role="status">
              <Skeleton variant="rounded" height={40} />
              <Typography sx={{ fontSize: "12px", opacity: 0.7 }}>
                Carregando serviços
              </Typography>
            </Stack>
          ) : servicesQuery.isError ? (
            <Stack spacing={1}>
              <Alert severity="error">Não foi possível carregar os serviços</Alert>
              <Button
                variant="contained"
                size="small"
                onClick={() => void servicesQuery.refetch()}
              >
                Tentar de novo
              </Button>
            </Stack>
          ) : servicesQuery.data?.customerId == null ? (
            <Typography
              sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
            >
              Nenhum cliente vinculado
            </Typography>
          ) : sortedServices.length === 0 ? (
            <Typography
              sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
            >
              Nenhum serviço encontrado
            </Typography>
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
        </Box>

        {/* Mensagens programadas section */}
        <Box
          component="section"
          aria-label="Mensagens programadas"
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Typography
              sx={{ fontWeight: 700, fontSize: "13px", color: "text.primary" }}
            >
              Mensagens programadas
            </Typography>
            {showVerTudoProgramadas &&
            !scheduledQuery.isLoading &&
            !scheduledQuery.isError ? (
              <Button
                size="small"
                variant="text"
                onClick={() => setRailView("programadasFull")}
                sx={{
                  textTransform: "none",
                  fontSize: "12px",
                  fontWeight: 600,
                  p: 0,
                  minWidth: "unset",
                  color: "text.secondary",
                }}
              >
                Ver tudo
              </Button>
            ) : null}
          </Box>
          {scheduledQuery.isLoading ? (
            <Stack spacing={1} role="status">
              <Skeleton variant="rounded" height={40} />
              <Typography sx={{ fontSize: "12px", opacity: 0.7 }}>
                Carregando mensagens programadas
              </Typography>
            </Stack>
          ) : scheduledQuery.isError ? (
            <Stack spacing={1}>
              <Alert severity="error">
                Não foi possível carregar as mensagens programadas
              </Alert>
              <Button
                variant="contained"
                size="small"
                onClick={() => void scheduledQuery.refetch()}
              >
                Tentar de novo
              </Button>
            </Stack>
          ) : servicesQuery.data?.customerId == null ? (
            <Typography
              sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
            >
              Nenhum cliente vinculado
            </Typography>
          ) : schedules.length === 0 ? (
            <Typography
              sx={{ textAlign: "center", fontSize: "12px", opacity: 0.6, py: 1 }}
            >
              Nenhuma mensagem programada
            </Typography>
          ) : (
            previewSchedules.map((row) => (
              <ScheduledRailRow
                key={row.id}
                row={row}
                onOpenDrillIn={() => openScheduleDrillIn(row.id, "stack")}
              />
            ))
          )}
        </Box>

        {/* Sugerir dados do cliente section */}
        <Box
          component="section"
          aria-label="Sugerir dados do cliente"
          sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
        >
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
            label={
              <Typography sx={{ fontSize: "13px", fontWeight: 500 }}>
                Sugerir dados do cliente
              </Typography>
            }
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
        </Box>
      </Stack>
    </>
  );
}
