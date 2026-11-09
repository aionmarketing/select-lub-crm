/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/parse.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. parse.ts is conversations' internal/ now; this
 * pure test sits in packages/core/test/ because internal/ may not import the test
 * fixtures (src/testing). Module role: none — no database.
 *
 * Setup: `parseCanonicalMessage`, `envelopeInstance`, `envelopeExternalId`
 * against `upsertPayload` (and a few hand-built envelopes). No store, no
 * HTTP. This file is the parser, not canonicalize.
 *
 * Techniques: EP of skip vs insert; decision coverage of parse.ts `if`s;
 * BVA on `messageTimestamp` (seconds vs milliseconds, 1e12 boundary).
 *
 * Spec (conversation-phone-unique delta whatsapp-channel; main
 * openspec/specs/channel/whatsapp-channel/spec.md still keys 1:1 identity on remote
 * JID and message uniqueness on (whatsapp_connection_id, external_message_id)
 * until that change is archived): authenticated 1:1 MESSAGES_UPSERT /
 * SEND_MESSAGE on a known connection become a message keyed by chat_key
 * digits; groups, broadcasts, @lid without a phone, unknown events, unknown
 * instance (null connection), and unusable timestamps MUST NOT become a
 * conversation/message. Direction comes from `fromMe`. Message type comes
 * from the Evolution payload shape; media is typed without fetching bytes.
 *
 * Decisions (T and F unless named infeasible):
 *   D1  asRecord(payload) null          — array / primitive / object
 *   D2  event missing or not canonical  — four event names vs MESSAGES_SET
 *   D3  !connectionId                   — null / "" vs id
 *   D4  data missing                    — null vs object vs data[0]
 *   D5  missing key.id or remoteJid
 *   D6  group / @broadcast / status@broadcast / @lid vs 1:1
 *   D6b conversationChatKeyFromJid null — empty local / letters-only 1:1 host
 *        (not group/@lid); device :12 not in digits; @c.us same digits as
 *        @s.whatsapp.net
 *   D7  !providerTimestamp              — missing, non-numeric, empty string
 *   D8  fromMe === true                 — outbound vs inbound
 *   D9  !message                        — unknown type
 *   D10 conversation string             — text; wins over extendedText
 *   D11 extendedTextMessage.text        — text when conversation absent
 *   D12–D15 image / audio / document / video records
 *   D12b image/video/document caption or document title → textBody;
 *        missing / whitespace caption → null (audio has no caption path)
 *   D16 timestamp number < 1e12 vs ≥ 1e12; string that parses as number
 *        BVA sampled: 1e12−1 (seconds), 1e12 and 1e12+1 (milliseconds)
 *   D17 parseHistoryMessage !connectionId — "" skip vs id insert
 *   D18 parseConnectionEvent !envelope / !event — skip (non-object, missing name)
 *   D19 STATUS_UPDATE_EVENTS — 1:1 + id → status-update; group / empty id skip
 *   D20 CONTENT_UNAVAILABLE_EVENTS — 1:1 delete → content-unavailable
 *   D21 mapEvolutionAck — D3 names/numbers vs unmapped null
 *   D22 envelopeExternalId keyId / data.id vs key.id
 *   D23 upsert still insert (not reclassified as status-update)
 *   D24 nested data.key + data.update.status (shape "key")
 *   D25 mapEvolutionAck numeric-STRING acks ("3", "4", " 5 ") and unmapped
 *        codes (99, "99", -1) and non-string/non-number inputs
 *   D26 readAckValue — `update.ack` and root `ack`, not only `status`
 *   D27 status-update timestamp: root, nested `update`, and absent (null)
 *   D28 the SECOND JID guard (conversationChatKeyFromJid null) on both
 *        parseStatusUpdate and parseContentUnavailable, distinct from the
 *        first (isGroupOrBroadcastJid) — see the note below
 *   D29 MESSAGES_UPDATE / MESSAGES_DELETE with no `data` at all
 *   D30 parseConnectionEvent `data` as a single-element ARRAY
 *
 * Two earlier dispositions in this header were wrong and are corrected:
 *
 *   "Infeasible: `new Date(ms)` NaN after a finite number (IEEE values we pass
 *   produce a valid Date)." — the parenthetical gives it away: it described the
 *   values the fixtures passed, not feasibility. parseTimestamp multiplies a
 *   sub-1e12 input by 1000, and a finite input can still exceed the Date range;
 *   `parseTimestamp(1e300)` is Invalid Date and must map to null. Now sampled.
 *
 *   "parseConnectionEvent `data` array vs object (line 210) belongs to
 *   reconcile-connection-state (connection-state.test.ts samples object
 *   `data.state`)." — that file samples the OBJECT arm, as the sentence itself
 *   says, so the ARRAY arm was deferred to a file that does not cover it and
 *   was sampled by nobody. Now sampled here.
 *
 * Note on the two JID guards: isGroupOrBroadcastJid (parse.ts:190) already
 * matches "@lid", so a LID is refused by the FIRST guard. The second guard is
 * reached only by a JID that is neither group/broadcast/lid and still yields no
 * digits ("abc@s.whatsapp.net", "@s.whatsapp.net"). They are separate decisions
 * that happen to agree, and only the first was previously sampled.
 *
 * Infeasible, verified rather than assumed:
 *   `status@broadcast` also matches `@broadcast`; still sampled as the spec's
 *   named JID.
 *   `ACK_BY_NUMBER[numeric] ?? null` (parse.ts:73) — the enclosing `if`
 *   requires that same lookup to be truthy, so the `?? null` arm cannot fire.
 *   `data ? mapEvolutionAck(...) : null` (parse.ts:352) — parseStatusUpdate
 *   returns skip whenever data is null (readExternalId yields null first), so
 *   the false arm is unreachable from any envelope.
 *
 * Fails if: a 1:1 upsert with a unix timestamp inserts as skip; a group JID
 * inserts; fromMe true is inbound; image is typed as text.
 *
 * parseHistoryMessage (REST row, no event field) — task 1.2:
 *   D17 1:1 + unix seconds → insert with that providerTimestamp
 *   D18 @g.us → skip
 *   D19 missing timestamp → skip
 *
 * Out of scope: persist/canonicalize transaction; live media download.
 */
import { describe, expect, it } from "vitest";
import { deletePayload, expectedTimestamp, historyRow, statusUpdatePayload, upsertPayload } from "../src/testing/evolution-payloads.js";
import {
  envelopeExternalId,
  envelopeInstance,
  isGroupOrBroadcastJid,
  mapEvolutionAck,
  mapEvolutionSessionState,
  parseCanonicalMessage,
  parseConnectionEvent,
  parseHistoryMessage,
  parseTimestamp,
} from "../src/modules/conversations/internal/parse.js";

const connectionId = "conn-1";
const JID = "5511999999999@s.whatsapp.net";
const phoneJid = "5511999999999@s.whatsapp.net";

describe("parseCanonicalMessage — skip (spec: no conversation/message)", () => {
  it.each([
    { name: "non-object envelope", payload: "not-json" },
    { name: "array envelope", payload: [] },
    { name: "null envelope", payload: null },
    { name: "unknown event", payload: upsertPayload({ event: "MESSAGES_SET" }) },
    { name: "missing event", payload: { ...upsertPayload(), event: undefined } },
    { name: "numeric event", payload: { ...upsertPayload(), event: 1 } },
    { name: "null connectionId", payload: upsertPayload(), connectionId: null },
    { name: "empty connectionId", payload: upsertPayload(), connectionId: "" },
    { name: "null data", payload: { ...upsertPayload(), data: null } },
    { name: "empty data array", payload: { ...upsertPayload(), data: [] } },
    { name: "missing message id", payload: upsertPayload({ id: "" }) },
    { name: "missing remoteJid", payload: upsertPayload({ remoteJid: "" }) },
    { name: "group JID", payload: upsertPayload({ remoteJid: "120363@g.us" }) },
    { name: "lid JID with no alternate", payload: upsertPayload({ remoteJid: "123456789012345@lid" }) },
    {
      name: "lid JID whose alternate is also a lid",
      payload: upsertPayload({ remoteJid: "123456789012345@lid", remoteJidAlt: "999888777666555@lid" }),
    },
    {
      name: "lid JID whose alternate has no digits",
      payload: upsertPayload({ remoteJid: "123456789012345@lid", remoteJidAlt: "abc@s.whatsapp.net" }),
    },
    {
      name: "lid JID with an empty alternate",
      payload: upsertPayload({ remoteJid: "123456789012345@lid", remoteJidAlt: "" }),
    },
    // Both observed in a real import on 2026-09-07, both previously becoming
    // customer conversations that the demo seed then decorated.
    { name: "newsletter JID", payload: upsertPayload({ remoteJid: "120363123456789012@newsletter" }) },
    { name: "WhatsApp system address", payload: upsertPayload({ remoteJid: "0@s.whatsapp.net" }) },
    { name: "1:1 JID with empty local", payload: upsertPayload({ remoteJid: "@s.whatsapp.net" }) },
    { name: "1:1 JID with no digits", payload: upsertPayload({ remoteJid: "abc@s.whatsapp.net" }) },
    { name: "broadcast JID", payload: upsertPayload({ remoteJid: "status@broadcast" }) },
    {
      name: "other broadcast JID",
      payload: upsertPayload({ remoteJid: "123@broadcast" }),
    },
    { name: "missing timestamp", payload: upsertPayload({ messageTimestamp: null }) },
    { name: "empty timestamp string", payload: { ...upsertPayload(), data: { ...upsertPayload().data, messageTimestamp: "   " } } },
    { name: "non-numeric timestamp", payload: { ...upsertPayload(), data: { ...upsertPayload().data, messageTimestamp: "not-a-time" } } },
    { name: "NaN timestamp", payload: { ...upsertPayload(), data: { ...upsertPayload().data, messageTimestamp: Number.NaN } } },
  ] as const)("skips $name", ({ payload, connectionId: id = connectionId }) => {
    expect(parseCanonicalMessage(payload, id)).toEqual({ status: "skip" });
  });
});

describe("LID addressing resolves to the phone on the alternate JID", () => {
  const LID = "123456789012345@lid";

  // The defect this covers dropped 30 of 32 real 1:1 chats, on the webhook path
  // as well as the history import, while every suite stayed green — no test
  // supplied an alternate, so nothing distinguished "skipped because lid" from
  // "skipped because unparseable".
  it("keys the conversation by the alternate's digits, not the LID digits", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: LID, remoteJidAlt: phoneJid }),
      connectionId,
    );
    expect(parsed.status).toBe("insert");
    expect(parsed.status === "insert" && parsed.message.chatKey).toBe("5511999999999");
  });

  // `remote_jid` is the send address by spec, and a LID JID cannot be sent to,
  // so storing it would leave a normal-looking conversation whose next reply
  // fails. Asserting the value rather than merely "not the lid" — a helper that
  // returned some third string would pass the weaker check.
  it("stores the alternate as the send address, not the LID JID", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: LID, remoteJidAlt: phoneJid }),
      connectionId,
    );
    expect(parsed.status === "insert" && parsed.message.remoteJid).toBe(phoneJid);
  });

  it("strips a device suffix from the alternate, as it does from a primary JID", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: LID, remoteJidAlt: "5511999999999:12@s.whatsapp.net" }),
      connectionId,
    );
    expect(parsed.status === "insert" && parsed.message.chatKey).toBe("5511999999999");
  });

  // Preference order matters: an event that already names a phone must not be
  // re-pointed by an alternate, or a stray field could silently move a message
  // into another customer's conversation.
  it("prefers the event's own JID when that already carries a phone", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: phoneJid, remoteJidAlt: "5511000000000@s.whatsapp.net" }),
      connectionId,
    );
    expect(parsed.status === "insert" && parsed.message.chatKey).toBe("5511999999999");
    expect(parsed.status === "insert" && parsed.message.remoteJid).toBe(phoneJid);
  });

  // A phone alternate must not smuggle a group into the canonical tables: groups
  // are out of MVP at the requirement level, not merely unsupported.
  it("still refuses a group JID that carries a phone alternate", () => {
    expect(
      parseCanonicalMessage(
        upsertPayload({ remoteJid: "120363@g.us", remoteJidAlt: phoneJid }),
        connectionId,
      ),
    ).toEqual({ status: "skip" });
  });

  // Pins the narrowing so it cannot widen back by accident: removing `@lid` from
  // this predicate is the change, and re-adding anything else here would be a
  // regression these four cases catch.
  it.each([
    { jid: "120363@g.us", skipped: true },
    { jid: "123@broadcast", skipped: true },
    { jid: "status@broadcast", skipped: true },
    { jid: "120363123456789012@newsletter", skipped: true },
    { jid: "123456789012345@lid", skipped: false },
    { jid: "5511999999999@s.whatsapp.net", skipped: false },
  ])("isGroupOrBroadcastJid($jid) is $skipped", ({ jid, skipped }) => {
    expect(isGroupOrBroadcastJid(jid)).toBe(skipped);
  });
});

describe("parseCanonicalMessage — insert", () => {
  it.each(["MESSAGES_UPSERT", "messages.upsert", "SEND_MESSAGE", "send.message"] as const)(
    "inserts canonical event %s",
    (event) => {
      const parsed = parseCanonicalMessage(upsertPayload({ event }), connectionId);

      expect(parsed.status).toBe("insert");
      if (parsed.status !== "insert") return;
      expect(parsed.message.whatsappConnectionId).toBe(connectionId);
      expect(parsed.message.externalMessageId).toBe("ABC123");
      expect(parsed.message.remoteJid).toBe(phoneJid);
      expect(parsed.message.chatKey).toBe("5511999999999");
      expect(parsed.message.providerTimestamp).toEqual(expectedTimestamp);
    },
  );

  it("reads the first element when data is an array", () => {
    const base = upsertPayload();
    const parsed = parseCanonicalMessage({ ...base, data: [base.data] }, connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.externalMessageId).toBe("ABC123");
    }
  });

  it("sets outbound when fromMe is true", () => {
    const parsed = parseCanonicalMessage(upsertPayload({ fromMe: true }), connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.direction).toBe("outbound");
    }
  });

  it("sets inbound when fromMe is not true", () => {
    const parsed = parseCanonicalMessage(upsertPayload({ fromMe: false }), connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.direction).toBe("inbound");
    }
  });

  it("treats a string fromMe as inbound", () => {
    const payload = upsertPayload();
    (payload.data as { key: { fromMe: unknown } }).key.fromMe = "true";

    const parsed = parseCanonicalMessage(payload, connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.direction).toBe("inbound");
    }
  });

  it("uses the same chat key for @c.us as for @s.whatsapp.net", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: "5511999999999@c.us" }),
      connectionId,
    );

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.chatKey).toBe("5511999999999");
      expect(parsed.message.remoteJid).toBe("5511999999999@c.us");
    }
  });

  it("drops a device suffix from the chat key", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ remoteJid: "5511999999999:12@s.whatsapp.net" }),
      connectionId,
    );

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.chatKey).toBe("5511999999999");
    }
  });
});

describe("parseCanonicalMessage — message types", () => {
  it("uses conversation text", () => {
    const parsed = parseCanonicalMessage(upsertPayload({ conversation: "oi" }), connectionId);

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "text", textBody: "oi" },
    });
  });

  it("uses extendedTextMessage when conversation is absent", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { extendedTextMessage: { text: "ola" } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "text", textBody: "ola" },
    });
  });

  it("keeps conversation text when extendedText is also present", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({
        message: { conversation: "oi", extendedTextMessage: { text: "ignored" } },
      }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "text", textBody: "oi" },
    });
  });

  it("does not treat extendedText without a string text as text", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { extendedTextMessage: { text: 1 } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "unknown", textBody: null },
    });
  });

  it.each([
    { field: "imageMessage", messageType: "image" },
    { field: "audioMessage", messageType: "audio" },
    { field: "documentMessage", messageType: "document" },
    { field: "videoMessage", messageType: "video" },
  ] as const)("types $field without a text body", ({ field, messageType }) => {
    const parsed = parseCanonicalMessage(upsertPayload({ message: { [field]: {} } }), connectionId);

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType, textBody: null },
    });
  });

  it("copies an image caption into textBody", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { imageMessage: { caption: "placa" } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "image", textBody: "placa" },
    });
  });

  it("copies a video caption into textBody", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { videoMessage: { caption: "video-cap" } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "video", textBody: "video-cap" },
    });
  });

  it("treats a whitespace image caption as no text body", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { imageMessage: { caption: "   " } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "image", textBody: null },
    });
  });

  it("copies a document title into textBody when caption is absent", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { documentMessage: { title: "orcamento.pdf" } } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "document", textBody: "orcamento.pdf" },
    });
  });

  it("types a missing message object as unknown", () => {
    const payload = upsertPayload();
    delete (payload.data as { message?: unknown }).message;

    const parsed = parseCanonicalMessage(payload, connectionId);

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "unknown", textBody: null },
    });
  });

  it("does not treat an array media field as a media record", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ message: { imageMessage: [] } }),
      connectionId,
    );

    expect(parsed).toMatchObject({
      status: "insert",
      message: { messageType: "unknown", textBody: null },
    });
  });
});

describe("parseCanonicalMessage — timestamp BVA", () => {
  it("treats unix seconds (below 1e12) as seconds", () => {
    const parsed = parseCanonicalMessage(upsertPayload({ messageTimestamp: 1_700_000_000 }), connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.providerTimestamp).toEqual(new Date(1_700_000_000_000));
    }
  });

  it("refuses a finite number too large to be a date", () => {
    // The seconds/milliseconds branch multiplies by 1000, so a finite input can
    // still overflow the Date range and yield Invalid Date. That must map to
    // null — "Missing provider timestamp is not canonicalized" makes the event
    // webhook-only, whereas an Invalid Date would reach the insert path and
    // write an unusable providerTimestamp that Relatórios then aggregates.
    expect(parseTimestamp(1e300)).toBeNull();
  });

  it("treats values at 1e12 as milliseconds (boundary)", () => {
    const parsed = parseCanonicalMessage(upsertPayload({ messageTimestamp: 1e12 }), connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.providerTimestamp).toEqual(new Date(1e12));
    }
  });

  it("treats 1e12 − 1 as seconds (boundary − 1)", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ messageTimestamp: 1e12 - 1 }),
      connectionId,
    );

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.providerTimestamp).toEqual(new Date((1e12 - 1) * 1000));
    }
  });

  it("treats 1e12 + 1 as milliseconds (boundary + 1)", () => {
    const parsed = parseCanonicalMessage(
      upsertPayload({ messageTimestamp: 1e12 + 1 }),
      connectionId,
    );

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.providerTimestamp).toEqual(new Date(1e12 + 1));
    }
  });

  it("parses a numeric timestamp string as seconds", () => {
    const payload = upsertPayload();
    (payload.data as { messageTimestamp: unknown }).messageTimestamp = "1700000000";

    const parsed = parseCanonicalMessage(payload, connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.providerTimestamp).toEqual(expectedTimestamp);
    }
  });
});

describe("parseHistoryMessage — REST row (no webhook event)", () => {
  it("inserts a 1:1 row with the unix providerTimestamp", () => {
    const parsed = parseHistoryMessage(historyRow(), connectionId);

    expect(parsed.status).toBe("insert");
    if (parsed.status === "insert") {
      expect(parsed.message.remoteJid).toBe(phoneJid);
      expect(parsed.message.providerTimestamp).toEqual(expectedTimestamp);
    }
  });

  it("skips a group JID", () => {
    expect(parseHistoryMessage(historyRow({ remoteJid: "120363@g.us" }), connectionId)).toEqual({
      status: "skip",
    });
  });

  it("skips a missing timestamp", () => {
    expect(parseHistoryMessage(historyRow({ messageTimestamp: null }), connectionId)).toEqual({
      status: "skip",
    });
  });

  it("skips when the REST connection id is empty", () => {
    expect(parseHistoryMessage(historyRow(), "")).toEqual({ status: "skip" });
  });
});

describe("envelope helpers", () => {
  it("reads instance from a string field", () => {
    expect(envelopeInstance(upsertPayload({ instance: "select-lub-test" }))).toBe("select-lub-test");
  });

  it("returns null when instance is missing or not a string", () => {
    expect(envelopeInstance({})).toBeNull();
    expect(envelopeInstance({ instance: 3 })).toBeNull();
    expect(envelopeInstance(null)).toBeNull();
  });

  it("reads external id from object data", () => {
    expect(envelopeExternalId(upsertPayload({ id: "MSG-1" }))).toBe("MSG-1");
  });

  it("reads external id from the first array data element", () => {
    const base = upsertPayload({ id: "ARR-1" });
    expect(envelopeExternalId({ ...base, data: [base.data] })).toBe("ARR-1");
  });

  it("returns null when the key id is missing", () => {
    expect(envelopeExternalId({ data: {} })).toBeNull();
    expect(envelopeExternalId({ data: [{ key: { id: 9 } }] })).toBeNull();
  });

  it("reads Evolution remapped keyId and delete id", () => {
    expect(envelopeExternalId(statusUpdatePayload({ id: "KEY-ID" }))).toBe("KEY-ID");
    expect(envelopeExternalId(deletePayload({ id: "DEL-1" }))).toBe("DEL-1");
  });
});

describe("mapEvolutionAck — design.md D3", () => {
  it.each([
    { raw: "DELIVERY_ACK", expected: "delivered" },
    { raw: "READ", expected: "read" },
    { raw: 2, expected: "sent" },
    { raw: "ERROR", expected: "failed" },
    { raw: "not-an-ack", expected: null },
    // A JSON payload can carry the ack as a stringified number, which is why
    // the numeric-string arm exists at all. It must map like the number:
    // dropping it silently discards a delivery or read receipt, and
    // whatsapp-channel's forward order (sent → delivered → read) then never
    // advances for that message.
    { raw: "3", expected: "delivered" },
    { raw: "4", expected: "read" },
    { raw: " 5 ", expected: "read" },
    // An ack code outside the known map must be null, not a guessed status.
    // "Provider status updates never regress" makes a wrong guess worse than
    // no update: a bogus `read` can never be corrected by a later `delivered`.
    { raw: 99, expected: null },
    { raw: "99", expected: null },
    { raw: -1, expected: null },
    // Non-string, non-number inputs reach the type guard rather than a map.
    { raw: null, expected: null },
    { raw: undefined, expected: null },
    { raw: true, expected: null },
    { raw: {}, expected: null },
    { raw: "", expected: null },
    { raw: "   ", expected: null },
  ])("$raw → $expected", ({ raw, expected }) => {
    expect(mapEvolutionAck(raw)).toBe(expected);
  });
});

describe("parseCanonicalMessage — status-update and delete", () => {
  it("maps a 1:1 MESSAGES_UPDATE with a provider id to status-update", () => {
    const parsed = parseCanonicalMessage(statusUpdatePayload({ status: "DELIVERY_ACK" }), connectionId);

    expect(parsed).toMatchObject({
      status: "status-update",
      externalMessageId: "ABC123",
      providerStatus: "delivered",
    });
  });

  it("maps SEND_MESSAGE_UPDATE the same way as MESSAGES_UPDATE", () => {
    const parsed = parseCanonicalMessage(
      statusUpdatePayload({ event: "SEND_MESSAGE_UPDATE", status: "READ" }),
      connectionId,
    );

    expect(parsed.status).toBe("status-update");
    if (parsed.status !== "status-update") {
      return;
    }
    expect(parsed.providerStatus).toBe("read");
  });

  it("reads nested key.id + update.status", () => {
    const parsed = parseCanonicalMessage(
      statusUpdatePayload({ shape: "key", status: "READ" }),
      connectionId,
    );
    expect(parsed).toMatchObject({ status: "status-update", providerStatus: "read" });
  });

  it("keeps status-update with a null providerStatus for an unmapped ack", () => {
    expect(parseCanonicalMessage(statusUpdatePayload({ status: "not-an-ack" }), connectionId)).toMatchObject({
      status: "status-update",
      providerStatus: null,
    });
  });

  it("maps a 1:1 MESSAGES_DELETE to content-unavailable", () => {
    expect(parseCanonicalMessage(deletePayload({ id: "GONE" }), connectionId)).toEqual({
      status: "content-unavailable",
      externalMessageId: "GONE",
    });
  });

  it("skips a group MESSAGES_UPDATE", () => {
    expect(
      parseCanonicalMessage(statusUpdatePayload({ remoteJid: "120363@g.us" }), connectionId),
    ).toEqual({ status: "skip" });
  });

  it("skips a status update with no provider id", () => {
    expect(parseCanonicalMessage(statusUpdatePayload({ id: "" }), connectionId)).toEqual({
      status: "skip",
    });
  });

  it("keeps upsert as insert", () => {
    expect(parseCanonicalMessage(upsertPayload(), connectionId).status).toBe("insert");
  });

  it.each([
    ["update.ack", { key: { id: "ACK-1", remoteJid: JID, fromMe: true }, update: { ack: 3 }, messageTimestamp: 1767225600 }],
    ["root ack", { keyId: "ACK-1", remoteJid: JID, fromMe: true, ack: 3, messageTimestamp: 1767225600 }],
  ])("reads the provider status from %s as well as from status", (_label, data) => {
    // Evolution spells the delivery receipt `status` on some payloads and `ack`
    // on others; readAckValue exists precisely to accept both, and only the
    // `status` spelling was sampled. A dropped `ack` spelling means the message
    // never leaves `sent` — whatsapp-channel's "Delivered advances sent" never
    // fires for those payloads.
    const parsed = parseCanonicalMessage(
      { event: "MESSAGES_UPDATE", instance: "select-lub-test", data },
      connectionId,
    );

    expect(parsed).toMatchObject({ status: "status-update", providerStatus: "delivered" });
  });

  it("takes the status timestamp from update when the root has none", () => {
    // "update that message's providerStatus and any timestamps present on the
    // event" — a payload carrying the timestamp only inside `update` still has
    // one present, so falling through to null would drop a delivered/read time
    // the event did supply.
    const parsed = parseCanonicalMessage(
      {
        event: "MESSAGES_UPDATE",
        instance: "select-lub-test",
        data: {
          key: { id: "ACK-2", remoteJid: JID, fromMe: true },
          update: { status: "READ", messageTimestamp: 1767225600 },
        },
      },
      connectionId,
    );

    expect(parsed).toMatchObject({ status: "status-update", providerStatus: "read" });
    expect(parsed.status === "status-update" ? parsed.at : null).toEqual(
      new Date(1767225600 * 1000),
    );
  });

  it.each([
    // isGroupOrBroadcastJid already matches "@lid" (parse.ts:190), so a LID is
    // refused by the FIRST guard. The second guard —
    // conversationChatKeyFromJid returning null — is reached only by a JID that
    // is none of group/broadcast/lid and still yields no digits. Both are
    // asserted because they are separate decisions that happen to agree.
    ["a group JID (first guard)", "120363@g.us"],
    ["a LID (first guard)", "abc123@lid"],
    ["a 1:1 host whose local part has no digits (second guard)", "abc@s.whatsapp.net"],
    ["an empty local part (second guard)", "@s.whatsapp.net"],
  ])("skips a status update for %s", (_label, remoteJid) => {
    expect(
      parseCanonicalMessage(statusUpdatePayload({ remoteJid }), connectionId),
    ).toEqual({ status: "skip" });
  });

  it.each([
    ["a group JID (first guard)", "120363@g.us"],
    ["a LID (first guard)", "abc123@lid"],
    ["a 1:1 host whose local part has no digits (second guard)", "abc@s.whatsapp.net"],
  ])("skips a MESSAGES_DELETE for %s", (_label, remoteJid) => {
    // "A delete for an unknown id, a group JID, or an unknown instance SHALL
    // remain a webhook event only." Both guards inside parseContentUnavailable
    // were untaken: every delete case sampled was the 1:1 happy path.
    expect(parseCanonicalMessage(deletePayload({ remoteJid }), connectionId)).toEqual({
      status: "skip",
    });
  });

  it("skips a MESSAGES_DELETE with no provider id", () => {
    expect(parseCanonicalMessage(deletePayload({ id: "" }), connectionId)).toEqual({
      status: "skip",
    });
  });

  it("keeps a status update with a null timestamp rather than inventing one", () => {
    // "update … any timestamps present on the event" — when none is present at
    // the root or inside `update`, the chain must end in null. Wall-clock here
    // would be the same defect outbox-send-provider-timestamp exists to
    // prevent, one layer over.
    const parsed = parseCanonicalMessage(
      statusUpdatePayload({ status: "READ", messageTimestamp: null }),
      connectionId,
    );

    expect(parsed).toMatchObject({ status: "status-update", providerStatus: "read" });
    expect(parsed.status === "status-update" ? parsed.at : "unset").toBeNull();
  });

  it.each([
    ["MESSAGES_UPDATE", "MESSAGES_UPDATE"],
    ["MESSAGES_DELETE", "MESSAGES_DELETE"],
  ])("skips %s when the envelope carries no data at all", (_label, event) => {
    // readExternalId / readRemoteJid each start with `if (!data) return null`.
    // parseStatusUpdate's own `data ? … : null` shows the author expected a
    // null data envelope, so it is a shape the parser is written for — it was
    // simply never sent one.
    expect(parseCanonicalMessage({ event, instance: "select-lub-test" }, connectionId)).toEqual({
      status: "skip",
    });
  });
});

describe("parseConnectionEvent — skip", () => {
  it("skips a non-object payload", () => {
    expect(parseConnectionEvent("nope")).toEqual({ status: "skip" });
  });

  it("skips a missing event name", () => {
    expect(parseConnectionEvent({})).toEqual({ status: "skip" });
  });

  it("reads the session state from an array-shaped data envelope", () => {
    // Evolution delivers CONNECTION_UPDATE data as a bare object on some
    // payloads and as a single-element array on others, which is why the
    // parser branches on Array.isArray. Only the object arm was sampled, so
    // dropping the array arm would silently stop every connection update that
    // arrives in the array shape — the canonical state would then sit stale at
    // whatever the last object-shaped event left, and Conversas would show a
    // disconnected instance as connected.
    expect(
      parseConnectionEvent({
        event: "CONNECTION_UPDATE",
        instance: "select-lub-test",
        data: [{ state: "open" }],
      }),
    ).toEqual({ status: "update", state: "CONNECTED" });
  });
});

describe("mapEvolutionSessionState", () => {
  it.each([
    { raw: "open", expected: "CONNECTED" as const },
    { raw: "connecting", expected: "CONNECTING" as const },
    { raw: "close", expected: "DISCONNECTED" as const },
    { raw: null, expected: null },
    { raw: "", expected: null },
    { raw: "foo", expected: null },
  ])("raw=$raw → $expected", ({ raw, expected }) => {
    expect(mapEvolutionSessionState(raw)).toBe(expected);
  });
});
