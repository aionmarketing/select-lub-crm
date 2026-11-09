/**
 * Test design (testing-strategy)
 *
 * Setup: multipartField / contentDisposition from conversations' internal/params.ts
 *   (moved from apps/api/src/http/multipart.test.ts in wave 5.2, when the api's
 *   duplicate of those two functions was deleted). No Fastify.
 *
 * Oracle: conversas media GET — document is an attachment download; image /
 * audio / video are inline. Form fields on media POST are strings; missing
 * or non-string values are omitted (API inject covers the route).
 *
 * Axes
 *   A1 fields shape — null / non-object / missing name / array / object
 *   A2 entry.value — string / number
 *   A3 messageType — document / image
 *   A4 fileName — null / quoted characters
 *
 * Outputs
 *   O1 undefined vs string field
 *   O2 attachment vs inline; safe filename
 *
 * Sampled-cell
 *   null fields        | A1 null     | O1 | invented string
 *   missing name       | A1 miss     | O1 | ""
 *   array first string | A1 array    | O1 | undefined
 *   non-string value   | A2 number   | O1 | String(n)
 *   document           | A3 document | O2 | inline
 *   image              | A3 image    | O2 | attachment
 *   null fileName      | A4 null     | O2 | empty filename
 *   quote in name      | A4 quote    | O2 | raw quote
 *
 * Decision / branch map (multipart.ts)
 *   !fields || typeof !== object   T null it; F object its
 *   Array.isArray(raw)             T array it; F object it
 *   !entry || typeof !== object    T missing it; F entry it
 *   typeof value === "string"      T string it; F number it
 *   messageType === "document"     T document it; F image it
 *
 * `fileName ?? "file"` is `??`, not an extra `if` (same treatment as #70).
 * schemas.ts has no if/switch/ternary (Zod only).
 * app-instance.ts is types only (no runtime `if`).
 *
 * Out of scope: route inject (conversations.route / media tests).
 */
import { describe, expect, it } from "vitest";
import { contentDisposition, multipartField } from "../src/modules/conversations/internal/params.js";

describe("HTTP multipart helpers", () => {
  it("returns undefined when fields is missing or not an object", () => {
    expect(multipartField(null, "caption")).toBeUndefined();
    expect(multipartField("x", "caption")).toBeUndefined();
  });

  it("reads the first array entry or a single object string value", () => {
    expect(multipartField({ caption: [{ value: "oi" }] }, "caption")).toBe("oi");
    expect(multipartField({ caption: { value: "oi" } }, "caption")).toBe("oi");
  });

  it("returns undefined when the named field is missing or the value is not a string", () => {
    expect(multipartField({}, "caption")).toBeUndefined();
    expect(multipartField({ caption: { value: 1 } }, "caption")).toBeUndefined();
  });

  it("uses attachment for documents and inline for other media, with a safe filename", () => {
    expect(contentDisposition("document", "nota.pdf")).toBe('attachment; filename="nota.pdf"');
    expect(contentDisposition("image", "foto.jpg")).toBe('inline; filename="foto.jpg"');
    expect(contentDisposition("image", null)).toBe('inline; filename="file"');
    expect(contentDisposition("audio", 'a"b\nc')).toBe('inline; filename="a_b_c"');
  });
});
