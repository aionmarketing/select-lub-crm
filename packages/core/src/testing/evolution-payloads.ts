/**
 * Builders for Evolution webhook payloads, for the tests of ingestion (conversations)
 * and of the worker that composes it. Moved from `apps/worker/src/ingest/fixtures.ts`
 * (4A) so both `packages/core` and `apps/worker` tests can use one copy. Test-only:
 * reached through `@select-lub/core/testing`, never the production barrel.
 */
const unix = 1_700_000_000;

/**
 * Builds a MESSAGES_UPSERT-style webhook envelope with overridable fields.
 *
 * @param options - Partial Evolution payload. `messageTimestamp: null` omits the timestamp field.
 * @returns Object shaped like Evolution's webhook body (`event`, `instance`, `data`).
 */
export function upsertPayload(options?: {
  event?: string;
  instance?: string;
  id?: string;
  fromMe?: boolean;
  remoteJid?: string;
  /** Phone-bearing JID WhatsApp sends beside a `@lid` remote JID. Omitted when undefined. */
  remoteJidAlt?: string;
  messageTimestamp?: number | null;
  conversation?: string;
  message?: Record<string, unknown>;
  dataExtra?: Record<string, unknown>;
}) {
  const data: Record<string, unknown> = {
    key: {
      id: options?.id ?? "ABC123",
      fromMe: options?.fromMe ?? false,
      remoteJid: options?.remoteJid ?? "5511999999999@s.whatsapp.net",
      ...(options?.remoteJidAlt === undefined ? {} : { remoteJidAlt: options.remoteJidAlt }),
    },
    message: options?.message ?? { conversation: options?.conversation ?? "oi" },
    ...options?.dataExtra,
  };
  if (options?.messageTimestamp !== null) {
    data.messageTimestamp = options?.messageTimestamp ?? unix;
  }
  return {
    event: options?.event ?? "MESSAGES_UPSERT",
    instance: options?.instance ?? "select-lub-test",
    data,
  };
}

/** Expected provider timestamp for the default fixture unix second. */
export const expectedTimestamp = new Date(unix * 1000);

/** Builds a CONNECTION_UPDATE webhook envelope with an optional Baileys state. */
export function connectionUpdatePayload(options?: {
  event?: string;
  instance?: string;
  state?: string | null;
}) {
  const data: Record<string, unknown> = {};
  if (options?.state !== null) {
    data.state = options?.state ?? "open";
  }
  return {
    event: options?.event ?? "CONNECTION_UPDATE",
    instance: options?.instance ?? "select-lub-test",
    data,
  };
}

/** Builds a QRCODE_UPDATED webhook envelope for pairing flows. */
export function qrUpdatedPayload(options?: { event?: string; instance?: string }) {
  return {
    event: options?.event ?? "QRCODE_UPDATED",
    instance: options?.instance ?? "select-lub-test",
    data: { qrcode: { base64: "not-real-qr-data", code: "not-real-pairing-code" } },
  };
}

/** Builds a MESSAGES_UPDATE delivery-ack webhook envelope. */
export function statusUpdatePayload(options?: {
  event?: string;
  instance?: string;
  id?: string;
  remoteJid?: string;
  status?: unknown;
  messageTimestamp?: number | null;
  shape?: "evolution" | "key";
}) {
  const id = options?.id ?? "ABC123";
  const remoteJid = options?.remoteJid ?? "5511999999999@s.whatsapp.net";
  const status = options?.status ?? "DELIVERY_ACK";
  const data =
    options?.shape === "key"
      ? {
          key: { id, remoteJid, fromMe: true },
          update: { status },
          ...(options?.messageTimestamp !== null
            ? { messageTimestamp: options?.messageTimestamp ?? unix }
            : {}),
        }
      : {
          keyId: id,
          remoteJid,
          fromMe: true,
          status,
          ...(options?.messageTimestamp !== null
            ? { messageTimestamp: options?.messageTimestamp ?? unix }
            : {}),
        };
  return {
    event: options?.event ?? "MESSAGES_UPDATE",
    instance: options?.instance ?? "select-lub-test",
    data,
  };
}

/** Builds a MESSAGES_DELETE webhook envelope. */
export function deletePayload(options?: {
  event?: string;
  instance?: string;
  id?: string;
  remoteJid?: string;
}) {
  return {
    event: options?.event ?? "MESSAGES_DELETE",
    instance: options?.instance ?? "select-lub-test",
    data: {
      id: options?.id ?? "ABC123",
      remoteJid: options?.remoteJid ?? "5511999999999@s.whatsapp.net",
      fromMe: true,
      status: "DELETED",
    },
  };
}

/** Builds a single findMessages REST row for history backfill tests. */
export function historyRow(options?: {
  id?: string;
  fromMe?: boolean;
  remoteJid?: string;
  /** Phone-bearing JID WhatsApp sends beside a `@lid` remote JID. Omitted when undefined. */
  remoteJidAlt?: string;
  messageTimestamp?: number | null;
  conversation?: string;
  extra?: Record<string, unknown>;
}) {
  const row: Record<string, unknown> = {
    key: {
      id: options?.id ?? "REST-1",
      fromMe: options?.fromMe ?? false,
      remoteJid: options?.remoteJid ?? "5511999999999@s.whatsapp.net",
      ...(options?.remoteJidAlt === undefined ? {} : { remoteJidAlt: options.remoteJidAlt }),
    },
    message: { conversation: options?.conversation ?? "oi" },
    ...options?.extra,
  };
  if (options?.messageTimestamp !== null) {
    row.messageTimestamp = options?.messageTimestamp ?? unix;
  }
  return row;
}
