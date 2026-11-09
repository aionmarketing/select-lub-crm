/**
 * Oil-quote HTTP.
 */
import {
  attendantFillSchema,
  oilQuoteSchema,
  quoteOptionsResultSchema,
  type AttendantFill,
  type CreateOilQuoteBody,
  type OilFillVolumeBody,
  type OilQuote,
  type QuoteOptionsResult,
} from "@select-lub/shared-types";
import { reportRefusedSession } from "../sessionRecovery.js";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Loads what the oil-change quote panel shows for one vehicle (background-oil-research D15):
 * the options, empty or missing-volume state of the identity's stored cache row, or its
 * background research state — `researching`, `no_spec` (with a `reason`), a clarification, a
 * conflict, or `error`. The server calls no provider to answer, so the read is quick whatever the
 * research costs; the dialog polls it while research runs.
 *
 * An `options` result always carries a `filters` block read from the stored Tecfil fitment:
 * `source` is `cached`, `pending` (with `stopped`), `unavailable` or `unmatched`, and the `oil`
 * and `fuel` slots each either offer catalog candidates (`matched`) or name why that type prices
 * nothing. The three row states carry the row's `consultedAt`, and either `refresh` (a new search
 * under way) or `newerAttempt` (a newer search that did not confirm a source).
 *
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @returns Parsed `QuoteOptionsResult` from `GET /vehicles/:vehicleId/quote-options`.
 */
export async function fetchQuoteOptions(vehicleId: string): Promise<QuoteOptionsResult> {
  const body = await parse(await apiRead(`${apiBase}/vehicles/${vehicleId}/quote-options`));
  return quoteOptionsResultSchema.parse(body);
}

/**
 * "Buscar novamente" (D16): asks the server to queue a new research of the vehicle's identity at
 * the front, searching the web whatever the miss window says. A POST, so neither a window refocus
 * nor a query retry can re-send it. The body is the same union as {@link fetchQuoteOptions}, so
 * the dialog shows the new research's progress from it with no further read.
 *
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @returns Parsed `QuoteOptionsResult` from `POST /vehicles/:vehicleId/oil-research/refetch`.
 */
export async function requestOilRefetch(vehicleId: string): Promise<QuoteOptionsResult> {
  // Bounded like every read: the enqueue is idempotent, so a request that timed out after the
  // server queued it is safe to send again, and the dialog shows the POST error copy meanwhile.
  const body = await parse(await apiRead(`${apiBase}/vehicles/${vehicleId}/oil-research/refetch`, { method: "POST" }));
  return quoteOptionsResultSchema.parse(body);
}

/**
 * A refused dead-end action (background-oil-research D24): the HTTP status and the parsed body, so
 * the dialog tells a 409 (read the quote again) from a 422 (the engine pick's `version_too_long`,
 * or the volume's `high_volume` warning) without parsing the message.
 */
export type OilActionRefusal = Error & { status: number; body: unknown };

/**
 * The status of a {@link OilActionRefusal}, or null for any other failure (a network error).
 *
 * @param error - What the mutation rejected with.
 */
export function oilActionRefusalStatus(error: unknown): number | null {
  const status = (error as Partial<OilActionRefusal> | null)?.status;
  return error instanceof Error && typeof status === "number" ? status : null;
}

/**
 * POSTs a JSON body; a non-OK answer throws an {@link OilActionRefusal}. Not retried: each writes.
 * Bounded like every read (`apiRead`), so a POST nobody answers fails and the dialog says so
 * instead of leaving its buttons disabled forever.
 */
async function postOilAction(url: string, body: unknown): Promise<unknown> {
  const response = await apiRead(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // The same session recovery every other request gets.
    if (response.status === 401) reportRefusedSession();
    const refused: unknown = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`http ${response.status}`), { status: response.status, body: refused });
  }
  return response.json();
}

/**
 * "Guardar para este modelo" (D24.1): keeps a typed fill volume for the vehicle's identity, with
 * the session user and the instant, for the next quotes of the same model. A volume above
 * 30 L (`HIGH_FILL_VOLUME_LITERS`) must carry `confirmHighVolume: true` — the dialog's "Usar mesmo
 * assim" — or the server answers 422 `{ warning: "high_volume" }` and stores nothing.
 *
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @param body - The liters (> 0, two decimals at most) and the high-volume confirmation.
 * @returns The stored `AttendantFill`.
 * @throws {@link OilActionRefusal} on 409 `incomplete_identity`, 422 `high_volume`, 404 or any other status.
 */
export async function recordOilFillVolume(vehicleId: string, body: OilFillVolumeBody): Promise<AttendantFill> {
  return attendantFillSchema.parse(await postOilAction(`${apiBase}/vehicles/${vehicleId}/oil-fill-volume`, body));
}

/**
 * An engine chosen in a clarification (D24.2): corrects the vehicle's version with it and queues
 * the re-read of the source the clarification found, for that engine. The answer is the
 * quote-options union — `researching` on the `engine_pick` path — written into the dialog's read.
 *
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @param engine - One engine the clarification named, verbatim.
 * @returns Parsed `QuoteOptionsResult`.
 * @throws {@link OilActionRefusal} on 409 (`not_clarification`, `engine_not_named`,
 * `version_changed`: read the quote again) and 422 `version_too_long` (correct the version by hand).
 */
export async function pickOilEngine(vehicleId: string, engine: string): Promise<QuoteOptionsResult> {
  return quoteOptionsResultSchema.parse(
    await postOilAction(`${apiBase}/vehicles/${vehicleId}/oil-research/engine-pick`, { engine }),
  );
}

/**
 * Persists a confirmed oil-change quote (frozen lines + final message text).
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @param body - Selected lines with offered prices and the assembled (possibly edited)
 * message. One line per selected oil card at its composite price (oil plus the chosen
 * filters), then one line per chosen filter item; the server re-freezes each filter line at
 * the catalog's current price and ignores the price sent for it.
 * @returns Parsed `OilQuote` from `POST /vehicles/:vehicleId/quotes`.
 */
export async function createOilQuote(vehicleId: string, body: CreateOilQuoteBody): Promise<OilQuote> {
  const json = await parse(
    await fetch(`${apiBase}/vehicles/${vehicleId}/quotes`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return oilQuoteSchema.parse(json);
}
