/**
 * The receipt's log summary of a raw Evolution webhook body: event, instance and
 * provider message id, never the body. Pure; no database, no clock.
 *
 * Moved here from `apps/worker/src/webhook.ts`. The envelope readers the receipt
 * also uses (`envelopeInstance`, `envelopeExternalId`) live in
 * `contracts/evolution-format.ts`, where ingestion reads them too (4A).
 */

/**
 * Extracts event, instance, and message id from a raw webhook body for logging.
 *
 * @param body - Unparsed Evolution webhook JSON body.
 * @returns Summary fields; uses `"unknown"` / `"none"` sentinels when values are missing or the body is not an object.
 */
export function summarizeWebhook(body: unknown) {
  if (!body || typeof body !== "object") {
    return { event: "unknown", instance: "unknown", externalMessageId: "none" };
  }
  const payload = body as {
    event?: unknown;
    instance?: unknown;
    data?: { key?: { id?: unknown } };
  };
  const event = typeof payload.event === "string" ? payload.event : "unknown";
  const instance = typeof payload.instance === "string" ? payload.instance : "unknown";
  const id = payload.data?.key?.id;
  const externalMessageId = typeof id === "string" ? id : "none";
  return { event, instance, externalMessageId };
}
