/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on exported schemas. No HTTP.
 *
 * Oracle: conversas / shared-types — empty tag list legal; send trims
 *   then min(1); ConversationSummary requires sourceType (AD|ORGANIC|
 *   UNKNOWN); channel status is `{ state }`; create-conversation phone
 *   non-empty. conversation-origin-classification task 1.2 — parse AD
 *   and reject omitted sourceType.
 *
 * Axes
 *   A1 HealthStatus shape — ok+skipped
 *   A2 summary.sourceType — UNKNOWN / AD / omitted
 *   A3 summary.tags — []
 *   A4 send text — "" / "   " / "a"
 *   A5 channel status — { state } / { connected }
 *   A6 create phone — "" / "   " / digits
 *   A7 message.providerStatus — delivered / omitted
 *   BVA: send and phone trim+min(1) — empty, whitespace, one char
 *
 * Outputs: O1 parse ok; O2 safeParse fails
 *
 * Sampled-cell
 *   health ok                 | A1        | O1 | throw
 *   summary UNKNOWN + []      | A2 A3     | O1 | invent Novo lead
 *   summary AD                | A2        | O1 | reject AD
 *   summary omits sourceType  | A2        | O2 | success true
 *   send ""                   | A4 BVA    | O2 | success true
 *   send whitespace           | A4 BVA    | O2 | success true
 *   send "a"                  | A4 BVA    | O1 | fail
 *   channel { state }         | A5        | O1 | fail
 *   channel { connected }     | A5        | O2 | success true
 *   phone empty/whitespace    | A6 BVA    | O2 | success true
 *   phone digits              | A6        | O1 | fail
 *   message delivered         | A7        | O1 | drop field
 *   message status omitted    | A7        | O1 | required
 *
 * Decision / branch map (zod): required sourceType T AD/UNKNOWN its;
 *   F omitted it. trim+min T "a"; F "" / whitespace.
 *
 * Out of scope: HTTP thread JSON (conversations.test.ts); report query
 *   sourceType (reports.test.ts).
 */
import { describe, expect, it } from "vitest";
import { channelStatusSchema } from "../../channel/contracts/http.js";
import { conversationMessageSchema, conversationSummarySchema, createConversationBodySchema, sendTextBodySchema } from "./http.conversation.js";
import type { HealthStatus } from "../../../shared/web/build-identity.js";

describe("HealthStatus", () => {
  it("accepts the ok payload used by GET /health", () => {
    const payload: HealthStatus = {
      status: "ok",
      database: "skipped",
      commit: "unknown",
      uiVariant: "cursor",
    };
    expect(payload.status).toBe("ok");
  });
});

describe("conversation contract", () => {
  it("parses a summary with an empty tag list and unknown source", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-1",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "UNKNOWN",
      unanswered: false,
      pipelineStage: "novosContatos",
    });
    expect(parsed.tags).toEqual([]);
    expect(parsed.sourceType).toBe("UNKNOWN");
  });

  it("parses a summary with sourceType AD", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-ad",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "AD",
      unanswered: false,
      pipelineStage: "novosContatos",
    });
    expect(parsed.sourceType).toBe("AD");
  });

  it("rejects a summary that omits unanswered", () => {
    expect(
      conversationSummarySchema.safeParse({
        id: "conv-1",
        contactLabel: "11999999999",
        phone: "11999999999",
        lastSnippet: "oi",
        lastMessageAt: "2026-08-26T12:00:00.000Z",
        tags: [],
        sourceType: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("parses unanswered true on a list row", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-1",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "UNKNOWN",
      unanswered: true,
      pipelineStage: "novosContatos",
    });
    expect(parsed.unanswered).toBe(true);
  });

  it("rejects a summary that omits sourceType", () => {
    expect(
      conversationSummarySchema.safeParse({
        id: "conv-1",
        contactLabel: "11999999999",
        phone: "11999999999",
        lastSnippet: "oi",
        lastMessageAt: "2026-08-26T12:00:00.000Z",
        tags: [],
      }).success,
    ).toBe(false);
  });

  it("rejects empty send text", () => {
    expect(sendTextBodySchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("rejects whitespace-only send text", () => {
    expect(sendTextBodySchema.safeParse({ text: "   " }).success).toBe(false);
  });

  it("parses a one-character send body", () => {
    expect(sendTextBodySchema.parse({ text: "a" })).toEqual({ text: "a" });
  });

  it("parses the four-state channel status", () => {
    expect(channelStatusSchema.parse({ state: "DISCONNECTED" })).toEqual({
      state: "DISCONNECTED",
    });
  });

  it("rejects the old boolean channel status shape", () => {
    expect(channelStatusSchema.safeParse({ connected: true }).success).toBe(false);
  });

  it("rejects an empty or whitespace-only create-conversation phone", () => {
    expect(createConversationBodySchema.safeParse({ phone: "" }).success).toBe(false);
    expect(createConversationBodySchema.safeParse({ phone: "   " }).success).toBe(false);
  });

  it("parses a non-empty create-conversation phone", () => {
    expect(createConversationBodySchema.parse({ phone: "11999999999" })).toEqual({
      phone: "11999999999",
    });
  });

  it("parses an outbound message with providerStatus delivered", () => {
    const parsed = conversationMessageSchema.parse({
      id: "msg-1",
      direction: "outbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: "2026-08-26T12:00:00.000Z",
      providerStatus: "delivered",
    });
    expect(parsed.providerStatus).toBe("delivered");
    expect(parsed.contentUnavailable).toBeUndefined();
  });

  it("parses a thread message when providerStatus is omitted", () => {
    const parsed = conversationMessageSchema.parse({
      id: "msg-2",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: "2026-08-26T12:00:00.000Z",
    });
    expect(parsed.providerStatus).toBeUndefined();
  });

  it("omits shouldReply when the thread message has no label", () => {
    const parsed = conversationMessageSchema.parse({
      id: "msg-3",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: "2026-08-26T12:00:00.000Z",
    });
    expect(parsed.shouldReply).toBeUndefined();
    expect("shouldReply" in parsed).toBe(false);
  });

  it("parses shouldReply true on a labeled inbound", () => {
    const parsed = conversationMessageSchema.parse({
      id: "msg-4",
      direction: "inbound",
      messageType: "text",
      textBody: "oi",
      providerTimestamp: "2026-08-26T12:00:00.000Z",
      shouldReply: true,
    });
    expect(parsed.shouldReply).toBe(true);
  });
});
