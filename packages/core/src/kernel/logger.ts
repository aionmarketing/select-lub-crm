/**
 * Pino options and the redaction helpers, shared by both composition roots.
 *
 * Lifted from `apps/api/src/logger.ts` and `apps/worker/src/logger.ts`, which
 * held the same three functions twice. Those files keep working until their
 * apps become composition roots in wave 5; this is where a slice imports them
 * from.
 */

/** Field names never written to a log line, whatever nests them. */
const SENSITIVE_LOG_KEYS = new Set(["authorization", "textbody", "text_body"]);

/** Fastify `redact.paths` entries for bearer tokens on inbound requests. */
export const fastifyLoggerRedactPaths = [
  "req.headers.authorization",
  "req.headers.Authorization",
] as const;

/** Default Fastify logger config with authorization header redaction. */
export const fastifyLoggerOptions = {
  level: "info",
  redact: {
    paths: [...fastifyLoggerRedactPaths],
    remove: true,
  },
};

/**
 * Drops log fields whose names match sensitive keys (case-insensitive).
 *
 * @param fields - Structured log object that may include bearer tokens or message bodies.
 * @returns Shallow copy with `authorization`, `textbody`, and `text_body` keys removed.
 */
export function omitSensitiveLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_LOG_KEYS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * JSON log line safe for stdout when message bodies may contain secrets.
 *
 * @param fields - Structured log object passed through {@link omitSensitiveLogFields}.
 * @returns JSON string suitable for Pino or test assertions.
 */
export function formatSafeLogLine(fields: Record<string, unknown>): string {
  return JSON.stringify(omitSensitiveLogFields(fields));
}
