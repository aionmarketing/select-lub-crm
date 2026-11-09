/**
 * What a failed Evolution send proves about delivery (`hold-unknown-outcome-sends`,
 * design D2). Split out of `evolution.ts` to keep that file under the line limit;
 * `postSend` there is the only caller.
 *
 * Read from Evolution v2.3.7's own source: `401`/`403` come from its auth guard
 * and `404` from its instance guard, before the send service runs; a `400` is
 * either the pre-send "not on WhatsApp" or the catch-all around the relay AND the
 * work after it; its `5xx` cannot be told from a proxy's.
 */
import type { EvolutionSendFailureKind, EvolutionSendResult } from "./ports.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Error codes that prove the connection to Evolution never opened, so the
 * request never reached it: DNS, refused, unreachable, and undici's connect
 * timeout. Anything that fails after the connection opened may have been sent.
 */
const PRE_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function causeOf(error: unknown): unknown {
  return (error as { cause?: unknown } | null)?.cause;
}

/**
 * Whether a thrown fetch error proves the connection never opened. undici wraps
 * the socket error as `TypeError: fetch failed` with it as `cause`; with several
 * addresses to try, `cause` is an `AggregateError` whose `errors` must all be
 * pre-connect.
 */
function neverConnected(error: unknown): boolean {
  const cause = causeOf(error);
  const nested = (cause as { errors?: unknown } | null)?.errors;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.every((inner) => PRE_CONNECT_CODES.has(errorCode(inner) ?? ""));
  }
  return PRE_CONNECT_CODES.has(errorCode(cause) ?? errorCode(error) ?? "");
}

/** A token for the log and `last_error`: the code, or the error's name. Never its message. */
function thrownToken(error: unknown): string {
  const code = errorCode(causeOf(error)) ?? errorCode(error);
  if (code) return code;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Whether a 400's body is Evolution's "not on WhatsApp" answer. `whatsappNumber()`
 * throws `BadRequestException(isWA)` before any send, which Evolution serialises
 * as `{ status: 400, error: "Bad Request", response: { message: [{ exists: false, … }] } }`.
 * Every other 400 from the send path comes from the one try/catch around the
 * relay AND the work after it (Evolution's own DB save, the chatbot emit), so it
 * does not prove the message was not sent.
 */
function notOnWhatsApp(body: unknown): boolean {
  const message = asRecord(asRecord(body)?.response)?.message;
  return (
    Array.isArray(message) &&
    message.length > 0 &&
    message.every((entry) => asRecord(entry)?.exists === false)
  );
}

/**
 * Whether a 404's body is Evolution's instance guard saying the instance does not
 * exist (`outbox-404-marks-disconnected`, review of #207).
 *
 * Evolution v2.3.7 answers 404 on these routes for exactly two reasons: the
 * instance guard (`src/api/guards/instance.guard.ts`, `The "x" instance does not
 * exist`) and Express's unknown-route fallback (`src/main.ts`,
 * `{ status: 404, error: "Not Found", response: { message: ["Cannot POST /…"] } }`).
 * Only the first is a fact about the session. A renamed route, or a proxy's own
 * 404, must never mark the shop's live connection disconnected, so anything else,
 * an unreadable body included, is not a missing instance.
 *
 * @param body - The parsed 404 body, or `undefined` when it could not be read.
 * @returns True only when a message in the body says the instance does not exist.
 */
export function instanceMissing(body: unknown): boolean {
  const record = asRecord(body);
  const nested = asRecord(record?.response)?.message;
  const messages = [
    ...(Array.isArray(nested) ? nested : [nested]),
    record?.message,
  ];
  return messages.some((message) => typeof message === "string" && /instance does not exist/i.test(message));
}

export function failure(kind: EvolutionSendFailureKind, error: string): EvolutionSendResult {
  return { ok: false, kind, error };
}

/**
 * Classifies an HTTP error answer to a send by what it proves about delivery.
 * `401`/`403` come from the auth guard and `404` from the instance guard, both
 * before the send service runs. Every `5xx` is unknown: the host is a third
 * party, and a proxy's answer cannot be told from Evolution's (ruling Q2).
 */
export async function classifyStatus(response: Response): Promise<EvolutionSendResult> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return failure("refused", "send_refused_unauthorized");
  }
  if (status === 404) {
    // Only the instance guard's 404 proves the send never ran. Express's
    // unknown-route 404 also never sends, but it says nothing about the session,
    // and a proxy's 404 says nothing at all: both are held as unknown rather than
    // allowed to mark the connection disconnected.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return instanceMissing(body)
      ? failure("disconnected", "evolution 404")
      : failure("unknown", "evolution 404 not an instance answer");
  }
  if (status === 400) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure("unknown", "evolution 400 unreadable");
    }
    return notOnWhatsApp(body)
      ? failure("refused", "send_refused_not_on_whatsapp")
      : failure("unknown", "evolution 400");
  }
  return failure("unknown", `evolution ${status}`);
}

/**
 * Classifies a thrown fetch: `retryable` only when the connection never opened,
 * `unknown` otherwise (the request may have been written).
 *
 * @param error - What `fetch` rejected with.
 */
export function classifyThrown(error: unknown): EvolutionSendResult {
  return failure(neverConnected(error) ? "retryable" : "unknown", `network ${thrownToken(error)}`);
}
