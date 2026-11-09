/**
 * Test design (testing-strategy)
 *
 * Setup: fetchConversations / fetchMe / createUser against MSW.
 * Session token comes from the zustand store (setupTests seeds it).
 *
 * Oracle: auth D1 — CRM HTTP sends Authorization Bearer from the session.
 *
 * Axes
 *   A1 token — present (seed) / cleared
 *   A2 create body — parsed Me
 *
 * Outputs
 *   O1 Authorization: Bearer test-access-token
 *   O2 no Authorization header
 *   O3 parsed Me from POST /users
 *
 * Sampled-cell
 *   list with seed token | A1 present | O1 | missing Bearer
 *   list after clear     | A1 cleared | O2 | leftover Bearer
 *   createUser 201       | A2         | O3 | throw
 *
 * Decision map (api/http.ts headers)
 *   D1 token T: seed it; F: cleared it
 *   D2 unitId session vs VITE_UNIT_ID: out of scope (same header helper)
 *
 * Out of scope: live Auth; x-unit-id membership 403 (API inject).
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { TEST_WEB_ACCESS_TOKEN, useAuthSession } from "./authSession.js";
import { createUser, fetchConversations, fetchMe } from "./api.js";
import { server } from "../test/msw/server.js";

afterEach(() => {
  server.resetHandlers();
});

describe("auth API client", () => {
  it("sends Authorization Bearer from the session on the conversation list", async () => {
    let authorization: string | null = null;
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json([]);
      }),
    );

    await fetchConversations();

    expect(authorization).toBe(`Bearer ${TEST_WEB_ACCESS_TOKEN}`);
  });

  it("omits Authorization when the session has no token", async () => {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    let authorization: string | null = "sentinel";
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json([]);
      }),
    );

    await fetchConversations();

    expect(authorization).toBeNull();
  });

  it("parses GET /auth/me", async () => {
    const me = await fetchMe();
    expect(me.email).toBe("attendant@example.com");
    expect(me.unitIds).toEqual(["unit-test"]);
  });

  it("parses POST /users", async () => {
    server.use(
      http.post("*/api/users", () =>
        HttpResponse.json(
          {
            id: "22222222-2222-2222-2222-222222222222",
            email: "nova@example.com",
            name: "Nova",
            unitIds: [],
          },
          { status: 201 },
        ),
      ),
    );

    const created = await createUser({
      email: "nova@example.com",
      password: "x",
      name: "Nova",
    });
    expect(created.id).toBe("22222222-2222-2222-2222-222222222222");
  });
});
