/**
 * Conversas labels, date/local helpers, and media type mapping.
 */
import type {
  ChannelStatus,
  ConversationMessage,
  ConversationSourceType,
  OmieSharedFieldKey,
  PrefillAcceptBody,
  PrefillFieldKey,
  ScheduledMessage,
  Service,
  Vehicle,
} from "@select-lub/shared-types";
import { useEffect, useState } from "react";

export const ORIGIN_LABELS: Record<ConversationSourceType, string> = {
  AD: "Anúncio",
  ORGANIC: "Orgânica",
  UNKNOWN: "Desconhecida",
};

export const CHANNEL_STATE_LABELS: Record<ChannelStatus["state"], string> = {
  CONNECTED: "Conectado",
  CONNECTING: "Conectando",
  DEGRADED: "Instável",
  DISCONNECTED: "Desconectado",
};

/** MUI's semantic palette (success/warning/error), not the dedicated
 * `whatsapp` brand token — this chip reports connection health, not a
 * WhatsApp-send action. */
export const CHANNEL_STATE_COLORS: Record<
  ChannelStatus["state"],
  "success" | "info" | "warning" | "error"
> = {
  CONNECTED: "success",
  CONNECTING: "info",
  DEGRADED: "warning",
  DISCONNECTED: "error",
};

/**
 * Builds a WhatsApp Web deep link for the given phone.
 * @param phone - Optional customer phone; non-digits are stripped, empty opens the generic WhatsApp Web home.
 * @returns `https://web.whatsapp.com/send?phone=…` or the base URL when no digits remain.
 */
export function whatsappWebUrl(phone?: string) {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return digits
    ? `https://web.whatsapp.com/send?phone=${digits}`
    : "https://web.whatsapp.com/";
}

/** Debounces `value` so inbox search does not refetch on every keystroke.
 * @param value - Live input value to delay.
 * @param delayMs - Milliseconds to wait after the last change before updating.
 * @returns Debounced copy of `value` used for `GET /conversations` search queries.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export const saoPauloDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "long",
});
const saoPauloDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
});
export const saoPauloTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Narrows a message type to media kinds the thread can render inline.
 * @param messageType - Stored message type from `ConversationMessage`.
 * @returns Type predicate true for image, audio, document, and video messages.
 */
export function isPlayableMedia(
  messageType: ConversationMessage["messageType"],
): messageType is "image" | "audio" | "document" | "video" {
  return (
    messageType === "image" ||
    messageType === "audio" ||
    messageType === "document" ||
    messageType === "video"
  );
}

/**
 * Maps a browser `File` MIME type to the outbox message type sent to the API.
 * @param file - Attachment chosen in the compose rail.
 * @returns `"document"` when the MIME type is not image, audio, or video.
 */
export function messageTypeFromFile(
  file: File,
): "image" | "audio" | "document" | "video" {
  if (file.type.startsWith("image/")) {
    return "image";
  }
  if (file.type.startsWith("audio/")) {
    return "audio";
  }
  if (file.type.startsWith("video/")) {
    return "video";
  }
  return "document";
}

/**
 * Groups messages by local calendar day in America/Sao_Paulo.
 * @param iso - UTC timestamp from `providerTimestamp`.
 * @returns `YYYY-MM-DD` day key in the São Paulo timezone.
 */
export function dayKey(iso: string) {
  return saoPauloDay.format(new Date(iso));
}

const saoPauloShortDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const saoPauloWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  weekday: "long",
});

const WEEKDAY_SHORT: Record<string, string> = {
  Monday: "Seg",
  Tuesday: "Ter",
  Wednesday: "Qua",
  Thursday: "Qui",
  Friday: "Sex",
  Saturday: "Sáb",
  Sunday: "Dom",
};

/**
 * WhatsApp-style relative timestamp for inbox conversation rows.
 *
 * - Same calendar day (São Paulo) → `"HH:MM"`
 * - Yesterday → `"Ontem"`
 * - 2–6 days ago → abbreviated weekday (`"Seg"`, `"Ter"`, …)
 * - 7+ days ago → `"DD/MM/YYYY"`
 *
 * Today and yesterday are decided on the São Paulo *calendar day*, not on
 * elapsed hours, so a message sent at 23:50 reads "Ontem" at 00:10 rather than
 * as a clock time. The weekday window is elapsed days, which is what makes the
 * seventh day fall through to a date instead of repeating today's weekday name.
 *
 * Only the antigravity inbox renders this; the cursor inbox keeps its own
 * format. It lives here rather than in a variant module because a date rule is
 * behaviour, and behaviour is written once.
 *
 * @param iso - UTC ISO timestamp (`lastMessageAt` from the conversation summary).
 * @param now - Current instant; pass a fixed date in tests for determinism.
 * @returns Relative timestamp matching WhatsApp Web behaviour.
 */
export function formatInboxTimestamp(iso: string, now: Date = new Date()): string {
  const msgDate = new Date(iso);
  const todayKey = saoPauloDay.format(now);
  const msgKey = saoPauloDay.format(msgDate);

  if (msgKey === todayKey) {
    return saoPauloTime.format(msgDate);
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (msgKey === saoPauloDay.format(yesterday)) {
    return "Ontem";
  }

  const diffMs = now.getTime() - msgDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    const englishWeekday = saoPauloWeekday.format(msgDate);
    return WEEKDAY_SHORT[englishWeekday] ?? englishWeekday.slice(0, 3);
  }

  return saoPauloShortDate.format(msgDate);
}

/**
 * Conversas title: stored customer name when non-empty, otherwise the conversation phone.
 */
export function conversasContactLabel(name: string | null | undefined, phone: string) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : phone;
}

export const PERSON_FIELDS = [
  { key: "name", label: "Nome" },
  { key: "taxId", label: "CPF/CNPJ" },
  { key: "primaryPhone", label: "Telefone principal" },
  { key: "primaryEmail", label: "E-mail" },
  { key: "street", label: "Rua" },
  { key: "streetNumber", label: "Número" },
  { key: "neighborhood", label: "Bairro" },
  { key: "complement", label: "Complemento" },
  { key: "city", label: "Cidade" },
  { key: "state", label: "UF" },
  { key: "postalCode", label: "CEP" },
  { key: "country", label: "País" },
] as const;

export const PENDING_FIELD_LABELS: Record<OmieSharedFieldKey, string> = {
  name: "Nome",
  taxId: "CPF/CNPJ",
  primaryPhone: "Telefone principal",
  primaryEmail: "E-mail",
  street: "Rua",
  streetNumber: "Número",
  neighborhood: "Bairro",
  complement: "Complemento",
  city: "Cidade",
  state: "UF",
  postalCode: "CEP",
  country: "País",
  plate: "Placa",
  make: "Marca",
  model: "Modelo",
  odometerKm: "Odômetro",
};

export const PREFILL_FIELD_LABELS: Record<PrefillFieldKey, string> = {
  name: "Nome",
  taxId: "CPF/CNPJ",
  plate: "Placa",
  make: "Marca",
  model: "Modelo",
  version: "Versão",
  year: "Ano",
  odometerKm: "Odômetro",
};

/**
 * Calendar date from an ISO timestamp, using the `YYYY-MM-DD` prefix so timezone offset cannot invent a neighbouring day.
 * @param iso - UTC timestamp, or null when the service has no performed date
 * @returns `DD/MM/YYYY`, or `""` when missing or not ISO-prefixed
 */
export function formatPerformedAt(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) {
    return "";
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Formats an ISO instant as a São Paulo calendar date `DD/MM/YYYY`.
 * @param iso - UTC timestamp from suggest-date or a scheduled row
 */
export function formatScheduleDate(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * Converts an ISO instant to a `datetime-local` value in America/São_Paulo.
 * @param iso - UTC timestamp to show in the schedule form
 */
export function isoToDatetimeLocal(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

/**
 * Interprets a `datetime-local` string as America/São_Paulo (UTC−3, no DST).
 * @param local - `YYYY-MM-DDTHH:mm` from a datetime-local input
 */
export function datetimeLocalToIso(local: string) {
  return new Date(`${local}:00-03:00`).toISOString();
}

/**
 * Formats a BRL amount, or empty when the service has no price.
 * @param amount - Stored amount, or null
 */
export function formatAmount(amount: number | null): string {
  if (amount == null) {
    return "";
  }
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    amount,
  );
}

/**
 * Formats odometer kilometres, or empty when unknown.
 * @param km - Stored kilometres, or null
 */
export function formatOdometer(km: number | null): string {
  if (km == null) {
    return "";
  }
  return `${new Intl.NumberFormat("pt-BR").format(km)} km`;
}

/**
 * Make / model / year line for a vehicle, empty when the vehicle is missing or has no identity fields.
 * @param vehicle - Linked vehicle, or undefined when the OS has no vehicle
 */
export function vehicleIdentity(vehicle: Vehicle | undefined): string {
  if (!vehicle) {
    return "";
  }
  return [
    vehicle.make,
    vehicle.model,
    vehicle.year == null ? null : String(vehicle.year),
  ]
    .filter((part): part is string => part != null && part.trim() !== "")
    .join(" ");
}

/**
 * Joins non-empty parts with a middle dot for rail titles.
 * @param parts - Label fragments; blank / null / undefined are dropped
 */
export function joinDot(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim() !== ""))
    .join(" · ");
}

/**
 * True when the service already has a scheduled message that is not cancelled.
 * @param schedules - Conversation scheduled rows
 * @param serviceId - OS id on the rail row
 */
export function serviceHasNonCancelledSchedule(
  schedules: ScheduledMessage[],
  serviceId: string,
) {
  // A reminder row names the service its return came from, but does not occupy
  // it: a return may carry several reminders, so counting them here would make
  // Criar lembrete unavailable after the first one.
  return schedules.some(
    (row) =>
      row.serviceId === serviceId &&
      row.returnReminderMessageId === null &&
      row.status !== "CANCELLED",
  );
}

/** Newest `performedAt` first, undated rows last — same order as the customer-services HTTP list. */
export function sortServicesRecentFirst(rows: Service[]): Service[] {
  return [...rows].sort((a, b) => {
    if (a.performedAt === null && b.performedAt === null) {
      return 0;
    }
    if (a.performedAt === null) {
      return 1;
    }
    if (b.performedAt === null) {
      return -1;
    }
    return b.performedAt.localeCompare(a.performedAt);
  });
}

/**
 * Parses a price typed in the quote dialog (`12,50` or `12.50`).
 * @param raw - Text-field value
 * @returns Non-negative finite number, or null when empty / negative / not numeric
 */
export function parseOfferedPrice(raw: string) {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Builds the accept body for one prefill field, coercing numeric fields.
 * @param field - Cadastro field key from the pending suggestion
 * @param value - Suggested scalar shown to the attendant
 */
export function acceptBodyFor(
  field: PrefillFieldKey,
  value: string | number,
): PrefillAcceptBody {
  if (field === "year") {
    return { field: "year", value: Number(value) };
  }
  if (field === "odometerKm") {
    return { field: "odometerKm", value: Number(value) };
  }
  return { field, value: String(value) } as PrefillAcceptBody;
}
