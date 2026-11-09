/**
 * Evolution REST clients for outbound sends, media fetch, history, and connection state.
 *
 * The production adapter behind channel's ports. Moved from
 * `apps/worker/src/outbox/evolution.ts` unchanged except for its imports: the two
 * value readers come from `contracts/evolution-format.ts`, the types
 * from `ports.ts`. The composition root builds these; tests never do, except this
 * file's own, which stubs `fetch`.
 *
 * SENDS ARE BOUNDED AND NEVER THROW (`hold-unknown-outcome-sends`, owner rule
 * 2026-09-25). Each send carries its own time limit, and every outcome comes
 * back as a result saying what a failure proves about delivery. A message that
 * might have reached the customer is never resent automatically, and what
 * Evolution v2.3.7 answers was read from its own source to decide which failures
 * prove that (see the change's design.md, D2).
 */
import { mapEvolutionSessionState, parseTimestamp } from "../contracts/evolution-format.js";
import type {
  EvolutionConnectionState,
  EvolutionConnectionStateResult,
  EvolutionHistory,
  EvolutionMediaFetchResult,
  EvolutionSend,
  EvolutionSendResult,
} from "./ports.js";
import { classifyStatus, classifyThrown, failure, instanceMissing } from "./send-classification.js";

/** Page size used when requesting findMessages from Evolution. */
export const HISTORY_PAGE_SIZE = 50;

function instancePathSegment(instanceName: string) {
  return encodeURIComponent(instanceName);
}

function evolutionConfig(options?: { baseUrl?: string; apiKey?: string }) {
  const baseUrl = (options?.baseUrl ?? process.env.SERVER_URL)?.replace(/\/$/, "");
  const apiKey = options?.apiKey ?? process.env.AUTHENTICATION_API_KEY;
  if (!baseUrl) {
    throw new Error("SERVER_URL is not set");
  }
  if (!apiKey) {
    throw new Error("AUTHENTICATION_API_KEY is not set");
  }
  return { baseUrl, apiKey };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function chatRemoteJid(row: unknown) {
  const record = asRecord(row);
  if (!record) {
    return null;
  }
  const fromField = readString(record.remoteJid);
  if (fromField) {
    return fromField;
  }
  const id = readString(record.id);
  return id?.includes("@") ? id : null;
}

function messagePage(body: unknown) {
  const root = asRecord(body);
  const wrapped = asRecord(root?.messages);
  const recordsValue = wrapped?.records ?? root?.records;
  const records = Array.isArray(recordsValue) ? recordsValue : [];
  const pages = typeof wrapped?.pages === "number" ? wrapped.pages : undefined;
  const currentPage = typeof wrapped?.currentPage === "number" ? wrapped.currentPage : undefined;
  const hasMore =
    records.length === 0
      ? false
      : typeof pages === "number" && typeof currentPage === "number"
        ? currentPage < pages
        : records.length >= HISTORY_PAGE_SIZE;
  return { records, hasMore };
}

function chatList(body: unknown) {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(asRecord(body)?.chats)
      ? (asRecord(body)?.chats as unknown[])
      : [];
  const chats: { remoteJid: string }[] = [];
  for (const row of rows) {
    const remoteJid = chatRemoteJid(row);
    if (remoteJid) {
      chats.push({ remoteJid });
    }
  }
  return chats;
}

function disconnectedStatus(status: number) {
  return status === 400 || status === 404 || status === 503;
}

async function postJson(url: string, apiKey: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return response;
}

/**
 * How long one text send may take before its outcome is treated as unknown
 * (`hold-unknown-outcome-sends`, ruling Q1). Before, a send waited on undici's
 * own 300 s headers timeout, which raced the reclaim pass's 300 s cutoff: a
 * reclaim that won queued the row again while the first send could still land.
 */
export const EVOLUTION_TEXT_SEND_TIMEOUT_MS = 30_000;

/**
 * How long one image, audio, video or document send may take. Longer than text:
 * the owner's point is "don't resend what might have arrived", not "fail slow
 * uploads", and a 16 MiB relay honestly takes time.
 */
export const EVOLUTION_MEDIA_SEND_TIMEOUT_MS = 120_000;

/**
 * Sends one message and never throws: every outcome is a result
 * (`hold-unknown-outcome-sends`). The time limit bounds the headers and the body
 * read alike.
 */
async function postSend(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<EvolutionSendResult> {
  let response: Response;
  try {
    response = await postJson(url, apiKey, body, AbortSignal.timeout(timeoutMs));
  } catch (error: unknown) {
    return classifyThrown(error);
  }
  if (!response.ok) {
    return classifyStatus(response);
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(await response.json());
  } catch {
    // Evolution answered 2xx, so it most likely relayed the message.
    return failure("unknown", "evolution 2xx unreadable");
  }
  const key = asRecord(payload?.key);
  const externalMessageId = readString(key?.id);
  if (!externalMessageId) {
    return failure("unknown", "missing provider id");
  }
  return { ok: true, externalMessageId, providerTimestamp: parseTimestamp(payload?.messageTimestamp) };
}

/**
 * Creates an Evolution REST client for outbound text, audio, and media sends.
 *
 * @param options - Optional Evolution base URL and API key overrides.
 * @param options.baseUrl - Evolution server root; defaults to `SERVER_URL`. Throws if both are unset.
 * @param options.apiKey - Evolution API key; defaults to `AUTHENTICATION_API_KEY`. Throws if both are unset.
 * @param options.textTimeoutMs - Per-send limit for text; defaults to {@link EVOLUTION_TEXT_SEND_TIMEOUT_MS}.
 * @param options.mediaTimeoutMs - Per-send limit for audio and media; defaults to {@link EVOLUTION_MEDIA_SEND_TIMEOUT_MS}.
 * @returns An {@link EvolutionSend} client for send and media-fetch endpoints. Its
 *   sends never throw; a failure says what it proves about delivery.
 */
export function createEvolutionSend(options?: {
  baseUrl?: string;
  apiKey?: string;
  textTimeoutMs?: number;
  mediaTimeoutMs?: number;
}): EvolutionSend {
  const { baseUrl, apiKey } = evolutionConfig(options);
  const textTimeoutMs = options?.textTimeoutMs ?? EVOLUTION_TEXT_SEND_TIMEOUT_MS;
  const mediaTimeoutMs = options?.mediaTimeoutMs ?? EVOLUTION_MEDIA_SEND_TIMEOUT_MS;

  return {
    async sendText(input) {
      return postSend(
        `${baseUrl}/message/sendText/${instancePathSegment(input.instanceName)}`,
        apiKey,
        { number: input.number, text: input.text },
        textTimeoutMs,
      );
    },
    async sendWhatsAppAudio(input) {
      return postSend(
        `${baseUrl}/message/sendWhatsAppAudio/${instancePathSegment(input.instanceName)}`,
        apiKey,
        { number: input.number, audio: input.audio },
        mediaTimeoutMs,
      );
    },
    async sendMedia(input) {
      return postSend(
        `${baseUrl}/message/sendMedia/${instancePathSegment(input.instanceName)}`,
        apiKey,
        {
          number: input.number,
          mediatype: input.mediatype,
          media: input.media,
          ...(input.mimetype ? { mimetype: input.mimetype } : {}),
          ...(input.fileName ? { fileName: input.fileName } : {}),
          ...(input.caption ? { caption: input.caption } : {}),
        },
        mediaTimeoutMs,
      );
    },
    async getBase64FromMediaMessage(input): Promise<EvolutionMediaFetchResult> {
      const response = await postJson(
        `${baseUrl}/chat/getBase64FromMediaMessage/${instancePathSegment(input.instanceName)}`,
        apiKey,
        {
          message: { key: { id: input.externalMessageId } },
          convertToMp4: input.convertToMp4,
        },
      );
      if (!response.ok) {
        return {
          ok: false,
          disconnected: disconnectedStatus(response.status),
          error: `evolution ${response.status}`,
        };
      }
      const payload = asRecord(await response.json());
      const base64 = readString(payload?.base64);
      if (!base64) {
        return { ok: false, disconnected: false, error: "missing media" };
      }
      return {
        ok: true,
        base64,
        mimetype: readString(payload?.mimetype),
        fileName: readString(payload?.fileName),
      };
    },
  };
}

/**
 * Creates an Evolution REST client for paginated chat history backfill.
 *
 * @param options - Optional Evolution base URL, API key, and fetch implementation.
 * @param options.baseUrl - Evolution server root; defaults to `SERVER_URL`. Throws if both are unset.
 * @param options.apiKey - Evolution API key; defaults to `AUTHENTICATION_API_KEY`. Throws if both are unset.
 * @param options.fetchImpl - Injectable fetch for tests; defaults to global `fetch`.
 * @returns An {@link EvolutionHistory} client for `findChats` and `findMessagesPage`.
 * @throws Propagates HTTP errors from `findChats` and `findMessagesPage` as `Error("evolution <status>")`.
 */
export function createEvolutionHistory(options?: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}): EvolutionHistory {
  const { baseUrl, apiKey } = evolutionConfig(options);
  const fetchImpl = options?.fetchImpl ?? fetch;

  async function post(path: string, body: unknown) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`evolution ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }

  return {
    async findChats(instanceName) {
      const body = await post(`/chat/findChats/${instancePathSegment(instanceName)}`, {});
      return chatList(body);
    },
    async findMessagesPage(instanceName, remoteJid, page) {
      const body = await post(`/chat/findMessages/${instancePathSegment(instanceName)}`, {
        where: { key: { remoteJid } },
        page,
        offset: HISTORY_PAGE_SIZE,
      });
      return messagePage(body);
    },
  };
}

type EvolutionFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * How long one connection-state lookup may take before it is abandoned.
 *
 * The reconcile runs inside the worker's heartbeat job, after the ingest retry
 * pass, and the job registry runs one tick of a job at a time. So a lookup that
 * never answered would hold the whole heartbeat — ingest retry included — until
 * Node's fetch gave up on its own (undici's headers timeout, 300 s); before the
 * registry, each heartbeat fired regardless. A lookup cut off here fails like any
 * other failed lookup, `{ ok: false }`, and the stored state is left alone. Ten
 * seconds is far above a healthy answer and well under the 30 s heartbeat.
 */
export const EVOLUTION_CONNECTION_STATE_TIMEOUT_MS = 10_000;

/**
 * Creates an Evolution REST client for live connection-state reconciliation.
 *
 * @param options - Optional Evolution base URL, API key, and fetch implementation.
 * @param options.baseUrl - Evolution server root; defaults to `SERVER_URL`. Throws if both are unset.
 * @param options.apiKey - Evolution API key; defaults to `AUTHENTICATION_API_KEY`. Throws if both are unset.
 * @param options.fetchImpl - Injectable fetch for tests; defaults to global `fetch`.
 * @param options.timeoutMs - Per-lookup bound; defaults to {@link EVOLUTION_CONNECTION_STATE_TIMEOUT_MS}.
 * @returns An {@link EvolutionConnectionState} client. Construction throws if
 *   `SERVER_URL` / `AUTHENTICATION_API_KEY` are missing; methods then never
 *   throw — failures return `{ ok: false }`. A `404` whose body says the
 *   instance does not exist is not a failure: it maps to `DISCONNECTED`.
 */
export function createEvolutionConnectionState(options?: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: EvolutionFetch;
  timeoutMs?: number;
}): EvolutionConnectionState {
  const { baseUrl, apiKey } = evolutionConfig(options);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? EVOLUTION_CONNECTION_STATE_TIMEOUT_MS;

  return {
    async getConnectionState(instanceName): Promise<EvolutionConnectionStateResult> {
      try {
        const response = await fetchImpl(`${baseUrl}/instance/connectionState/${instancePathSegment(instanceName)}`, {
          headers: { apikey: apiKey },
          // Bounds the headers and the body read alike: an abort rejects either,
          // into the catch below.
          signal: AbortSignal.timeout(timeoutMs),
        });
        // A 404 from Evolution's instance guard (the instance does not exist) is
        // a fact about the session, not a failed lookup (owner 2026-10-07,
        // `outbox-404-marks-disconnected`). Skipping it left a missing instance
        // stored as CONNECTED, which kept re-releasing its blocked reminders. Any
        // other 404 (an unknown route, a proxy) is a failed lookup like any other
        // (review of #207): it must never flip a live connection.
        if (response.status === 404) {
          let notFound: unknown;
          try {
            notFound = await response.json();
          } catch {
            notFound = undefined;
          }
          return instanceMissing(notFound) ? { ok: true, evolutionState: "DISCONNECTED" } : { ok: false };
        }
        if (!response.ok) {
          return { ok: false };
        }
        const body = asRecord(await response.json());
        const instance = asRecord(body?.instance);
        const mapped = mapEvolutionSessionState(readString(instance?.state) ?? readString(body?.state));
        if (!mapped) {
          return { ok: false };
        }
        return { ok: true, evolutionState: mapped };
      } catch {
        return { ok: false };
      }
    },
  };
}
