/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on send-media, media-fetch error, thread
 * message, and existing text-send schemas. No HTTP, no file bytes.
 *
 * Oracle: openspec/changes/whatsapp-media-on-demand/specs/shared-types/spec.md
 *   — image send with no caption parses; text send still rejects whitespace;
 *   ConversationMessage has no required file-bytes or durable URL field.
 *
 * Techniques: EP (one invalid class per `it`), BVA on text trim().min(1)
 * already sampled in index.test.ts (re-asserted here because this delta
 * names that scenario), membership EP on messageType enum.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 media-send messageType
 *   EP valid: image | audio | document | video (sampled image without caption)
 *   EP invalid: text / unknown / missing (sampled "text" as one class; missing
 *   is the same enum-reject shape — one `it`)
 *   Not sampled: audio/document/video success (same enum members as image)
 *
 * A2 caption presence
 *   EP valid: omitted; present non-empty
 *   Sampled: omitted (spec scenario). Present caption not sampled — optional
 *   string has no extra refine.
 *
 * A3 text-send body
 *   EP invalid: "" and "   " (same trim partition; both in one `it` as the
 *   spec names both as empty after trim)
 *
 * A4 thread message fields
 *   EP valid: existing ConversationMessage keys only
 *   Assert: parsed object has no mediaUrl / bytes / fileUrl required key
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                                              | axes        | O | fails if
 * parses image send with no caption               | A1 valid A2 | 1 | parse throws
 * rejects media send when messageType is text     | A1 invalid  | 2 | success
 * rejects empty send text                         | A3 invalid  | 2 | success
 * parses thread message without file fields       | A4 valid    | 1 | parse throws
 *                                                 |             |   | or keys include
 *                                                 |             |   | mediaUrl/bytes
 * image without caption is [Imagem]               | snippet     |   | other label
 * image with caption keeps the caption            | snippet     |   | [Imagem]
 * text without body is blank                      | snippet     |   | [Imagem]
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map
 * ----------------------------------------------------------------------------
 * messageType in {image,audio,document,video} true — image `it`
 * messageType in enum false — text `it`
 * text trim min(1) false — empty send `it`
 * ConversationMessage object keys — no-file-fields `it`
 *
 * Out of scope: multipart file bytes; 16 MiB cap (API inject in task 4.2);
 * HTTP 404 for text messages; caption present; every valid media type.
 */
import { describe, expect, it } from "vitest";
import { conversationListSnippet, conversationMessageSchema, mediaFetchErrorSchema, sendMediaBodySchema, sendTextBodySchema } from "./http.conversation.js";

describe("sendMediaBodySchema", () => {
  it("parses an image send with no caption", () => {
    const parsed = sendMediaBodySchema.parse({ messageType: "image" });

    expect(parsed.messageType).toBe("image");
    expect(parsed.caption).toBeUndefined();
  });

  it("rejects a media send when messageType is text", () => {
    expect(sendMediaBodySchema.safeParse({ messageType: "text" }).success).toBe(false);
  });
});

describe("sendTextBodySchema", () => {
  it("rejects empty send text", () => {
    expect(sendTextBodySchema.safeParse({ text: "" }).success).toBe(false);
    expect(sendTextBodySchema.safeParse({ text: "   " }).success).toBe(false);
  });
});

describe("conversationMessageSchema", () => {
  it("parses a thread message without file fields", () => {
    const parsed = conversationMessageSchema.parse({
      id: "msg-1",
      direction: "inbound",
      messageType: "image",
      textBody: null,
      providerTimestamp: "2026-08-26T12:00:00.000Z",
    });

    expect(parsed).not.toHaveProperty("mediaUrl");
    expect(parsed).not.toHaveProperty("bytes");
    expect(parsed).not.toHaveProperty("fileUrl");
  });
});

describe("mediaFetchErrorSchema", () => {
  it("parses media_unavailable", () => {
    const parsed = mediaFetchErrorSchema.parse({ code: "media_unavailable" });

    expect(parsed.code).toBe("media_unavailable");
  });
});

describe("conversationListSnippet", () => {
  it("uses a Portuguese image label when there is no caption", () => {
    expect(conversationListSnippet("image", null)).toBe("[Imagem]");
  });

  it("keeps a caption instead of the type label", () => {
    expect(conversationListSnippet("image", "foto do motor")).toBe("foto do motor");
  });

  it("does not invent a media label for text", () => {
    expect(conversationListSnippet("text", null)).toBe("");
  });

  it.each([
    { messageType: "audio" as const, label: "[Áudio]" },
    { messageType: "video" as const, label: "[Vídeo]" },
    { messageType: "document" as const, label: "[Documento]" },
  ])("labels $messageType when there is no caption", ({ messageType, label }) => {
    expect(conversationListSnippet(messageType, null)).toBe(label);
  });
});
