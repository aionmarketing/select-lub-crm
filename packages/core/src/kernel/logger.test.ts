/**
 * Test design (testing-strategy)
 *
 * Setup: omitSensitiveLogFields / formatSafeLogLine on a plain object.
 * No Fastify, no network.
 *
 * Spec rule (deploy D5): production logs must not include Authorization
 * or full message bodies (textBody).
 *
 * Axes
 *   A1 field — authorization / textBody / other
 *
 * Outputs
 *   O1 key dropped; O2 other keys kept; O3 serialized line omits secrets
 *
 * Sampled-cell
 *   authorization + textBody + event | A1 mix | O1+O2+O3 | secret in line
 *   only event                       | A1 other | O2 | dropped event
 *
 * Decision map
 *   D1 key in SENSITIVE_LOG_KEYS T: authorization/textBody; F: event it
 *
 * Out of scope: Pino redact of req.headers at runtime (needs a live logger);
 *   the exported redact path list is asserted here as the Fastify config.
 */
import { describe, expect, it } from "vitest";
import { fastifyLoggerRedactPaths, formatSafeLogLine, omitSensitiveLogFields } from "./logger.js";

describe("omitSensitiveLogFields", () => {
  it("drops authorization and textBody so a helper cannot interpolate them", () => {
    const line = formatSafeLogLine({
      authorization: "Bearer SECRET-TOKEN",
      textBody: "full message body with CPF 000",
      event: "MESSAGES_UPSERT",
    });

    expect(omitSensitiveLogFields({
      authorization: "Bearer SECRET-TOKEN",
      textBody: "full message body with CPF 000",
      event: "MESSAGES_UPSERT",
    })).toEqual({ event: "MESSAGES_UPSERT" });
    expect(line).toContain("MESSAGES_UPSERT");
    expect(line).not.toContain("SECRET-TOKEN");
    expect(line).not.toContain("full message body");
    expect(line).not.toContain("Bearer");
  });

  it("keeps unrelated fields when no sensitive keys are present", () => {
    expect(omitSensitiveLogFields({ event: "heartbeat", instance: "select-lub-poc" })).toEqual({
      event: "heartbeat",
      instance: "select-lub-poc",
    });
  });

  it("lists Authorization header paths on the Fastify logger redact config", () => {
    expect(fastifyLoggerRedactPaths).toContain("req.headers.authorization");
    expect(fastifyLoggerRedactPaths).toContain("req.headers.Authorization");
  });
});
