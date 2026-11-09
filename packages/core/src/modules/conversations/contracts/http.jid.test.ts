/**
 * Test design (testing-strategy)
 *
 * Setup: `conversationChatKeyFromJid` is pure. No store, no HTTP.
 *
 * Oracle: conversation-phone-unique / whatsapp-channel — 1:1 chat_key is
 * digits of the JID local part before `:` or `@`; `@s.whatsapp.net` and
 * `@c.us` collapse; device `:12` is not digits; `@lid` / `@g.us` /
 * `@broadcast` are not a phone.
 *
 * Axes
 *   A1 host — s.whatsapp.net / c.us / lid / g.us / broadcast / none (typed phone)
 *   A2 local part — digits only / digits+device suffix / no digits
 *
 * Outputs: O1 digits string; O2 null (skip)
 *
 * Sampled-cell
 *   @s.whatsapp.net same digits     | A1 s.net  A2 digits | O1 | other key
 *   @c.us same digits               | A1 c.us   A2 digits | O1 | other key
 *   :12 suffix                      | A1 s.net  A2 device | O1 | digits+12
 *   typed phone (no host)           | A1 none   A2 digits | O1 | null
 *   @lid                            | A1 lid              | O2 | LID digits
 *   @LID mixed case                 | A1 lid              | O2 | LID digits
 *   @g.us                           | A1 g.us             | O2 | group digits
 *   @G.US mixed case                | A1 g.us             | O2 | group digits
 *   @C.US mixed case                | A1 c.us   A2 digits | O1 | other key
 *   @broadcast                      | A1 broadcast        | O2 | digits
 *   empty local                     | A1 s.net  A2 empty  | O2 | insert
 *
 * Decision map
 *   D1 host is g.us / broadcast / lid — true: lid/g.us/broadcast `it`s; false: phone `it`s
 *   D2 digits after strip empty — true: empty local; false: phone `it`s
 *   D3 colon in local — true: :12; false: plain digits
 *
 * Out of scope: ninth-digit BR; writing `@g.us` as a stored chat_key (reserved,
 * not produced by this helper).
 */
import { describe, expect, it } from "vitest";
import { conversationChatKeyFromJid } from "./http.jid.js";

describe("conversationChatKeyFromJid", () => {
  it.each([
    { jid: "5511999999999@s.whatsapp.net", key: "5511999999999" }, // same digits, s.net
    { jid: "5511999999999@c.us", key: "5511999999999" }, // same digits, c.us
    { jid: "5511999999999@C.US", key: "5511999999999" }, // host case folded
    { jid: "5511999999999:12@s.whatsapp.net", key: "5511999999999" }, // device suffix not digits
    { jid: "5511999999999", key: "5511999999999" }, // typed phone, no host
    { jid: "+55 11 99999-9999", key: "5511999999999" }, // punctuation in local
  ])("$jid → $key", ({ jid, key }) => {
    expect(conversationChatKeyFromJid(jid)).toBe(key);
  });

  it.each([
    { jid: "123456789012345@lid", name: "@lid is not a phone" },
    { jid: "123456789012345@LID", name: "@LID host case folded skip" },
    { jid: "120363@g.us", name: "@g.us stays a skip" },
    { jid: "120363@G.US", name: "@G.US host case folded skip" },
    { jid: "status@broadcast", name: "status@broadcast skip" },
    { jid: "123@broadcast", name: "@broadcast skip" },
    { jid: "@s.whatsapp.net", name: "empty local is not a phone" },
    // Both came out of a real import on 2026-09-07, not from imagining inputs.
    // Two newsletters became customer conversations the seed then decorated, and
    // WhatsApp's own system address opened a conversation keyed `0`.
    { jid: "120363123456789012@newsletter", name: "@newsletter is a channel, not a chat" },
    { jid: "120363123456789012@NEWSLETTER", name: "@NEWSLETTER host case folded skip" },
    { jid: "0@s.whatsapp.net", name: "WhatsApp system address is not a phone" },
  ])("$name", ({ jid }) => {
    expect(conversationChatKeyFromJid(jid)).toBeNull();
  });

  // BVA on the E.164 digit bound. 7 and 16 are the values that separate reject
  // from accept, so they are the pair that distinguishes `<`/`<=` from a
  // stray `>`/`>=`; a test at 3 and 30 would pass against an off-by-one.
  describe("phone-length bound (E.164, 8–15 digits)", () => {
    it.each([
      { digits: 7, key: null },
      { digits: 8, key: "88888888" },
      { digits: 15, key: "1".repeat(15) },
      { digits: 16, key: null },
    ])("a $digits-digit local part", ({ digits, key }) => {
      const local = digits === 8 ? "88888888" : "1".repeat(digits);
      const expected = key === null ? null : local;
      expect(conversationChatKeyFromJid(`${local}@s.whatsapp.net`)).toBe(expected);
    });

    // The device suffix is stripped before the bound is applied, so a valid
    // phone must not be rejected for the suffix's extra digits.
    it("measures the phone, not the device suffix", () => {
      expect(conversationChatKeyFromJid("5511999999999:123@s.whatsapp.net")).toBe("5511999999999");
    });
  });
});
