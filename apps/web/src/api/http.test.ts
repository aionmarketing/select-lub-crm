/**
 * Test design (testing-strategy)
 *
 * Setup: headers/parse/filenameFromContentDisposition from http.ts.
 * Session from useAuthSession (setupTests seeds a bearer).
 *
 * Oracle: auth D1 — CRM HTTP sends Authorization when a session token
 * exists and omits it when cleared; unit header follows currentUnitId.
 * Media GET uses a quoted filename from Content-Disposition.
 * parse throws `http <status>` on !ok (same contract as api.*.test.ts).
 *
 * Axes
 *   A1 token — present / null
 *   A2 unitId — session set / null
 *   A3 response.ok — true / false
 *   A4 Content-Disposition — null / unquoted / quoted
 *
 * Outputs
 *   O1 Authorization present or omitted
 *   O2 x-unit-id present or omitted
 *   O3 JSON body or thrown `http 500`
 *   O4 filename or null
 *
 * Sampled-cell
 *   seed token          | A1 on     | O1 | missing Bearer
 *   cleared token       | A1 off    | O1 | leftover Bearer
 *   session unit        | A2 set    | O2 | missing x-unit-id
 *   no unit             | A2 null   | O2 | leftover x-unit-id
 *   parse 200           | A3 ok     | O3 | throw
 *   parse 500           | A3 !ok    | O3 | parsed body
 *   disposition null    | A4 null   | O4 | invented name
 *   unquoted            | A4 none   | O4 | raw header
 *   quoted              | A4 match  | O4 | null
 *
 * Decision / branch map (http.ts)
 *   if (token)        T seed it; F cleared it
 *   if (unitId)       T session it; F null+unset env it
 *   if (!response.ok) T 500 it; F 200 it
 *   if (!header)      T null it; F quoted/unquoted its
 *   match?.[1] ??     T quoted it; F unquoted it
 *
 * `?? import.meta.env.VITE_UNIT_ID` when session unit is null is the same
 * helper leftover named in api.auth.test.ts (env, not a second `if`).
 *
 * Out of scope: resource schemas (api.*.test.ts).
 */
import { describe, expect, it } from "vitest";
import { TEST_WEB_ACCESS_TOKEN, useAuthSession } from "../authSession.js";
import { filenameFromContentDisposition, headers, parse } from "./http.js";

describe("web API http helpers", () => {
  it("attaches Authorization when the session has a token", () => {
    const next = headers() as Record<string, string>;
    expect(next.Authorization).toBe(`Bearer ${TEST_WEB_ACCESS_TOKEN}`);
  });

  it("omits Authorization when the session token is cleared", () => {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    const next = headers() as Record<string, string>;
    expect(next.Authorization).toBeUndefined();
  });

  it("attaches x-unit-id from the session and omits it when both session and env are empty", () => {
    useAuthSession.setState({
      accessToken: TEST_WEB_ACCESS_TOKEN,
      currentUnitId: "unit-session",
      ready: true,
    });
    expect((headers() as Record<string, string>)["x-unit-id"]).toBe("unit-session");

    useAuthSession.setState({ accessToken: TEST_WEB_ACCESS_TOKEN, currentUnitId: null, ready: true });
    const without = headers() as Record<string, string>;
    if (!import.meta.env.VITE_UNIT_ID) {
      expect(without["x-unit-id"]).toBeUndefined();
    }
  });

  it("parses JSON on ok and throws http <status> otherwise", async () => {
    await expect(parse(new Response(JSON.stringify({ ok: true }), { status: 200 }))).resolves.toEqual({
      ok: true,
    });
    await expect(parse(new Response("nope", { status: 500 }))).rejects.toThrow("http 500");
  });

  it("reads a quoted filename from Content-Disposition and returns null when missing or unquoted", () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition("inline")).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename="nota.pdf"')).toBe("nota.pdf");
  });
});
