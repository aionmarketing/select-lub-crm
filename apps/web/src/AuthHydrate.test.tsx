/**
 * Test design (testing-strategy)
 *
 * Setup: App in MemoryRouter + AppProviders. Query retry: false.
 * setupTests seeds a session; this file sets ready: false / accessToken: null
 * so AuthHydrate runs. MSW stubs GoTrue POST /auth/v1/token (password grant).
 * resetSupabaseClientCache(null) stubs a missing Auth client (cached client
 * would otherwise survive VITE_SUPABASE_URL from vitest.config test.env).
 * beforeEach signs out the Auth client and clears localStorage so a prior
 * grant's in-memory session is not reused via GoTrue's shared storage key.
 *
 * Oracle: openspec/changes/mvp-auto-login/specs/auth Login screen —
 * auto-login password grant from VITE_MVP_LOGIN_EMAIL / VITE_MVP_LOGIN_PASSWORD;
 * existing session skips grant; failed/missing env/missing client → Portuguese
 * LOGIN_FAILED_COPY, no Conversas fetch, no credential form; `/` logged out
 * does not show heading "Entrar".
 *
 * Second oracle: openspec/changes/session-recovery/specs/auth, requirement
 * **Session continuity** — a refreshed token is used; a refused stored session
 * falls back to the grant; a session refused mid-life is re-established without
 * a reload; recovery that fails resolves to the failure copy. Those four
 * scenarios have their own axes (A7–A10), outputs (O6–O9) and sampled-cell
 * table on the `AuthHydrate session continuity` describe below, kept there
 * rather than merged into the tables above because they sample a different
 * grid: this header's axes are all about the FIRST session, and continuity is
 * about what happens to one that already existed.
 *
 * Axes
 *   A1 session on load — none / zustand already ready / Auth getSession token
 *   A2 Vite credentials — both present / missing email / missing password
 *   A3 Auth client — present / missing (cached null)
 *   A4 password grant — success / Auth error / session-less success / throw
 *   A5 path — / /login /follow-up /relatorios /configuracoes /usuarios /galeria
 *   A6 GET /auth/me — currentUnitId present / absent with memberships /
 *      absent with zero memberships / HTTP failure / never answers at all
 *
 * Outputs
 *   O1 Conversas heading; conversations GET Authorization Bearer
 *   O2 LOGIN_FAILED_COPY; conversations GET count 0; no heading "Entrar";
 *      no e-mail/password fields
 *   O3 grant POST count 0; Conversas still available
 *   O4 "Carregando…" while RequireAuth !ready
 *   O5 useAuthSession currentUnitId; conversations GET x-unit-id header
 *
 * Sampled-cell
 *   grant succeeds on / and /login | A1 none A2 both A3 present A4 success A5 /,/login | O1 | Conversas heading, Bearer, heading Entrar
 *   zustand session already ready | A1 zustand | O3 | grant POST count
 *   Auth getSession already has token | A1 getSession | O3 | grant POST count
 *   failed grant on product paths | A4 Auth error A5 each | O2 | LOGIN_FAILED_COPY, GET count, Entrar
 *   missing email | A2 missing email | O2 | LOGIN_FAILED_COPY, grant count 0
 *   missing password | A2 missing password | O2 | LOGIN_FAILED_COPY, grant count 0
 *   missing Auth client | A3 missing | O2 | LOGIN_FAILED_COPY, grant count 0
 *   grant returns no session | A4 session-less | O2 | LOGIN_FAILED_COPY
 *   getSession throws | A4 throw | O2 | LOGIN_FAILED_COPY
 *   hydrate in flight | A1 none A4 delayed success | O4 then O1 | Carregando… then Conversas
 *   logged-out / | A5 / A4 success | no Entrar | heading Entrar
 *   me names the unit | A4 success A6 currentUnitId | O5 | currentUnitId, x-unit-id
 *   me omits it, two memberships | A4 success A6 absent+memberships | O5 | first unitIds entry
 *   me omits it, zero memberships | A6 absent+none | O5 | null id, no x-unit-id
 *   me fails | A6 failure | O1+O5 | Conversas still reached, null id
 *   me never answers | A6 hangs | O5 | resolve pending past the deadline
 *   me answers in time | A6 currentUnitId | O5 | deadline firing early
 *   existing session resolves too | A1 getSession A6 currentUnitId | O5 | currentUnitId
 *
 * Decision map (AuthHydrate + hydrateMvpSession + RequireAuth)
 *   D1 hasRunRef.current T: infeasible in RTL (same-mount second effect; React
 *      StrictMode remounts a new ref) — named out of scope; coverage finder
 *      still shows AppProviders.tsx:46-47
 *   D1 F: every hydrate it
 *   D2 ready already T: zustand existing-session it; F: hydrate its
 *   D3 !client T: missing-client it; F: client-present its
 *   D3b supabaseClient !url||!key T: missing-env client it; F: cached/present its
 *   D4 getSession access_token T: getSession existing-session it; F: grant / fail its
 *   D5 !email T: missing-email it; F: missing-password + both-present its
 *   D6 !password T: missing-password it; F: both-present its
 *   D7 signIn error T: failed-grant its; F: success / session-less its
 *   D8 !signedIn.session T: session-less it; F: success its
 *   D9 catch T: getSession throws it; F: try path its
 *   D12 resolveCurrentUnitId catch T: me-fails it (rejection) and never-answers
 *      it (deadline); F: every other hydrate it
 *   D14 Promise.race winner — fetch: answers-in-time it; timer: never-answers
 *      it. The timer branch is the one with no other way in: a hang produces no
 *      rejection of its own, so without the race nothing reaches D12 at all
 *   D13 me.currentUnitId ?? unitIds[0] ?? null — T/T: me-names-unit it;
 *      F/T: two-memberships it; F/F: zero-memberships it
 *   D10 RequireAuth !ready T: Carregando it; F: ready its
 *   D11 RequireAuth !accessToken T: O2 its; F: O1/O3 its
 *   AppProviders queryClient omitted T: not this SUT (every it passes an
 *      override); coverage finder AppProviders.tsx:67-71
 *
 * Out of scope: the ME_TIMEOUT_MS default VALUE (8s of real time; the deadline
 * tests pass their own so the suite does not spend it, and the constant is a
 * product judgement, not behaviour); unit SWITCHING (no picker exists; the store is
 * written once per hydrate); the `?? import.meta.env.VITE_UNIT_ID` fallback in api/http.ts
 * (owned by http.test.ts); whether the API 403s a multi-unit caller that sends
 * no x-unit-id (apps/api auth tests).
 * Out of scope: Playwright; Fastify inject; live Supabase; restoring /login
 * via a flag; sign-out; whitespace-only env (unspecified); AppProviders
 * default QueryClient factory when `queryClient` is omitted (coverage finder:
 * AppProviders.tsx 67-71; this file always passes a client with retry: false).
 */
import type { Session } from "@supabase/supabase-js";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { fetchMe } from "./api/auth.js";
import { AppProviders, resolveCurrentUnitId } from "./AppProviders.js";
import { LOGIN_FAILED_COPY, TEST_WEB_ACCESS_TOKEN, useAuthSession } from "./authSession.js";
import { getSupabaseClient, resetSupabaseClientCache } from "./supabaseClient.js";
import { server } from "../test/msw/server.js";

const SESSION_TOKEN = "session-token";
const PRODUCT_PATHS = [
  "/",
  "/login",
  "/follow-up",
  "/relatorios",
  "/configuracoes",
  "/usuarios",
  "/galeria",
] as const;

function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders queryClient={queryClient}>
        <App />
      </AppProviders>
    </MemoryRouter>,
  );
}

function assertNoLoginForm() {
  expect(screen.queryByRole("heading", { name: "Entrar" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/E-mail/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^Senha/)).not.toBeInTheDocument();
}

function grantSuccessBody(email: string) {
  return {
    access_token: SESSION_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "refresh-token",
    user: { id: "user-1", aud: "authenticated", role: "authenticated", email },
  };
}

function passwordGrantHandler() {
  return http.post("*/auth/v1/token", async ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("grant_type") && url.searchParams.get("grant_type") !== "password") {
      return HttpResponse.json({ error: "unsupported_grant" }, { status: 400 });
    }
    const contentType = request.headers.get("content-type") ?? "";
    let password: string;
    let email = "a@example.com";
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { email?: string; password?: string };
      password = body.password ?? "";
      email = body.email ?? email;
    } else {
      const params = new URLSearchParams(await request.text());
      password = params.get("password") ?? "";
      email = params.get("email") ?? email;
    }
    if (password !== import.meta.env["VITE_MVP_LOGIN_PASSWORD"]) {
      return HttpResponse.json(
        { error: "invalid_grant", msg: "Invalid login credentials" },
        { status: 400 },
      );
    }
    return HttpResponse.json(grantSuccessBody(email));
  });
}

function failingPasswordGrantHandler() {
  return http.post("*/auth/v1/token", () =>
    HttpResponse.json({ error: "invalid_grant", msg: "Invalid login credentials" }, { status: 400 }),
  );
}

beforeEach(async () => {
  useAuthSession.setState({
    accessToken: null,
    currentUnitId: null,
    ready: false,
    // See `setupTests.ts`: both are sticky across tests unless cleared, and
    // `recoveryFailed` short-circuits recovery entirely once set.
    recovering: false,
    recoveryFailed: false,
  });
  const client = getSupabaseClient();
  if (client) {
    await client.auth.signOut({ scope: "local" });
  }
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AuthHydrate auto-login", () => {
  it.each(["/", "/login"] as const)(
    "reaches Conversas with Authorization after a successful grant from %s",
    async (path) => {
      const conversationAuth: string[] = [];
      server.use(
        passwordGrantHandler(),
        http.get("*/api/conversations", ({ request }) => {
          conversationAuth.push(request.headers.get("authorization") ?? "");
          return HttpResponse.json([]);
        }),
      );

      renderApp(path);

      expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
      assertNoLoginForm();
      await waitFor(() => {
        expect(conversationAuth.length).toBeGreaterThan(0);
      });
      expect(conversationAuth[0]).toBe(`Bearer ${SESSION_TOKEN}`);
    },
  );

  it("does not call the password grant when the SPA session is already ready", async () => {
    useAuthSession.setState({
      accessToken: TEST_WEB_ACCESS_TOKEN,
      currentUnitId: null,
      ready: true,
    });
    let grants = 0;
    const conversationAuth: string[] = [];
    server.use(
      http.post("*/auth/v1/token", () => {
        grants += 1;
        return HttpResponse.json({ error: "should-not-run" }, { status: 500 });
      }),
      http.get("*/api/conversations", ({ request }) => {
        conversationAuth.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(grants).toBe(0);
    await waitFor(() => {
      expect(conversationAuth.length).toBeGreaterThan(0);
    });
    expect(conversationAuth[0]).toBe(`Bearer ${TEST_WEB_ACCESS_TOKEN}`);
  });

  it("does not call the password grant when Auth already has a session", async () => {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    let grants = 0;
    vi.spyOn(client.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: SESSION_TOKEN } as Session },
      error: null,
    });
    server.use(
      http.post("*/auth/v1/token", () => {
        grants += 1;
        return HttpResponse.json({ error: "should-not-run" }, { status: 500 });
      }),
      http.get("*/api/conversations", () => {
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(grants).toBe(0);
    expect(useAuthSession.getState().accessToken).toBe(SESSION_TOKEN);
  });

  it.each(PRODUCT_PATHS)(
    "shows a Portuguese error on %s when the password grant fails and does not fetch conversations",
    async (path) => {
      const conversationAuth: string[] = [];
      server.use(
        failingPasswordGrantHandler(),
        http.get("*/api/conversations", ({ request }) => {
          conversationAuth.push(request.headers.get("authorization") ?? "");
          return HttpResponse.json([]);
        }),
      );

      renderApp(path);

      expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
      assertNoLoginForm();
      expect(conversationAuth).toEqual([]);
    },
  );

  it.each([
    { missing: "VITE_MVP_LOGIN_EMAIL" as const },
    { missing: "VITE_MVP_LOGIN_PASSWORD" as const },
  ])("shows a Portuguese error when $missing is missing and does not fetch conversations", async ({
    missing,
  }) => {
    vi.stubEnv(missing, "");
    let grants = 0;
    const conversationAuth: string[] = [];
    server.use(
      http.post("*/auth/v1/token", () => {
        grants += 1;
        return HttpResponse.json({ error: "should-not-run" }, { status: 500 });
      }),
      http.get("*/api/conversations", ({ request }) => {
        conversationAuth.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
    assertNoLoginForm();
    expect(grants).toBe(0);
    expect(conversationAuth).toEqual([]);
  });

  it("shows a Portuguese error when the Auth client is missing and does not fetch conversations", async () => {
    resetSupabaseClientCache(null);
    try {
      let grants = 0;
      const conversationAuth: string[] = [];
      server.use(
        http.post("*/auth/v1/token", () => {
          grants += 1;
          return HttpResponse.json({ error: "should-not-run" }, { status: 500 });
        }),
        http.get("*/api/conversations", ({ request }) => {
          conversationAuth.push(request.headers.get("authorization") ?? "");
          return HttpResponse.json([]);
        }),
      );

      renderApp("/");

      expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
      assertNoLoginForm();
      expect(grants).toBe(0);
      expect(conversationAuth).toEqual([]);
    } finally {
      resetSupabaseClientCache();
    }
  });

  it("shows a Portuguese error when the grant returns no session", async () => {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    vi.spyOn(client.auth, "getSession").mockResolvedValue({
      data: { session: null },
      error: null,
    });
    vi.spyOn(client.auth, "signInWithPassword").mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof client.auth.signInWithPassword>>);
    const conversationAuth: string[] = [];
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        conversationAuth.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
    assertNoLoginForm();
    expect(conversationAuth).toEqual([]);
  });

  it("shows a Portuguese error when getSession throws and does not fetch conversations", async () => {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    vi.spyOn(client.auth, "getSession").mockRejectedValue(new Error("auth unavailable"));
    const conversationAuth: string[] = [];
    server.use(
      http.get("*/api/conversations", ({ request }) => {
        conversationAuth.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
    assertNoLoginForm();
    expect(conversationAuth).toEqual([]);
  });

  it("shows Carregando while hydrate is in flight then reaches Conversas", async () => {
    server.use(
      http.post("*/auth/v1/token", async ({ request }) => {
        await delay(80);
        const contentType = request.headers.get("content-type") ?? "";
        let email = "a@example.com";
        if (contentType.includes("application/json")) {
          const body = (await request.json()) as { email?: string };
          email = body.email ?? email;
        }
        return HttpResponse.json(grantSuccessBody(email));
      }),
      http.get("*/api/conversations", () => HttpResponse.json([])),
    );

    renderApp("/");

    expect(screen.getByText("Carregando…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
  });

  it("does not show Entrar when an unauthenticated browser opens /", async () => {
    server.use(passwordGrantHandler(), http.get("*/api/conversations", () => HttpResponse.json([])));

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    assertNoLoginForm();
  });

  it("builds no Auth client when VITE_SUPABASE_URL is missing", () => {
    resetSupabaseClientCache(undefined);
    vi.stubEnv("VITE_SUPABASE_URL", "");
    expect(getSupabaseClient()).toBeNull();
    resetSupabaseClientCache(undefined);
  });
});

/**
 * A user with more than one membership is refused (403) on every unit-scoped
 * route until `x-unit-id` is sent, so hydration must learn the unit before it
 * flips `ready` and lets those requests go out.
 */
describe("AuthHydrate current unit", () => {
  const ME = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "attendant@example.com",
    name: "Atendente",
  };

  /** Overrides `GET /auth/me` with one body, or a status when `body` is a number. */
  function meHandler(body: Record<string, unknown> | number) {
    return http.get("*/api/auth/me", () =>
      typeof body === "number"
        ? HttpResponse.json({ error: "boom" }, { status: body })
        : HttpResponse.json(body),
    );
  }

  /** Records the `x-unit-id` of every conversation list request. */
  function conversationsUnitSpy(seen: (string | null)[]) {
    return http.get("*/api/conversations", ({ request }) => {
      seen.push(request.headers.get("x-unit-id"));
      return HttpResponse.json([]);
    });
  }

  it("takes currentUnitId from /auth/me and sends it as x-unit-id", async () => {
    const units: (string | null)[] = [];
    server.use(
      passwordGrantHandler(),
      meHandler({ ...ME, unitIds: ["unit-a", "unit-b"], currentUnitId: "unit-b" }),
      conversationsUnitSpy(units),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().currentUnitId).toBe("unit-b");
    await waitFor(() => {
      expect(units.length).toBeGreaterThan(0);
    });
    expect(units[0]).toBe("unit-b");
  });

  it("falls back to the first membership when /auth/me cannot resolve one", async () => {
    const units: (string | null)[] = [];
    server.use(
      passwordGrantHandler(),
      meHandler({ ...ME, unitIds: ["unit-a", "unit-b"] }),
      conversationsUnitSpy(units),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().currentUnitId).toBe("unit-a");
    await waitFor(() => {
      expect(units.length).toBeGreaterThan(0);
    });
    expect(units[0]).toBe("unit-a");
  });

  it("leaves the unit null and sends no x-unit-id when the user holds none", async () => {
    const units: (string | null)[] = [];
    server.use(
      passwordGrantHandler(),
      meHandler({ ...ME, unitIds: [] }),
      conversationsUnitSpy(units),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().currentUnitId).toBeNull();
    await waitFor(() => {
      expect(units.length).toBeGreaterThan(0);
    });
    expect(units[0]).toBeNull();
  });

  it("still reaches Conversas with a null unit when /auth/me fails", async () => {
    const units: (string | null)[] = [];
    server.use(passwordGrantHandler(), meHandler(500), conversationsUnitSpy(units));

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().currentUnitId).toBeNull();
    await waitFor(() => {
      expect(units.length).toBeGreaterThan(0);
    });
    expect(units[0]).toBeNull();
  });

  // The reason the catch in resolveCurrentUnitId is not enough on its own: a
  // server that accepts the connection and never answers produces no rejection,
  // so without the raced deadline this resolve would stay pending, `ready` would
  // never be written, and the app would sit on "Carregando…" forever. Passing a
  // short deadline proves the mechanism without spending the real 8 seconds.
  it("gives up and returns null when /auth/me never answers", async () => {
    server.use(
      http.get("*/api/auth/me", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );

    await expect(resolveCurrentUnitId(20)).resolves.toBeNull();
  });

  it("returns the unit when /auth/me answers before the deadline", async () => {
    server.use(meHandler({ ...ME, unitIds: ["unit-a"], currentUnitId: "unit-a" }));

    await expect(resolveCurrentUnitId(5000)).resolves.toBe("unit-a");
  });

  it("resolves the unit on the existing-session path too", async () => {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    vi.spyOn(client.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: SESSION_TOKEN } as Session },
      error: null,
    });
    server.use(
      meHandler({ ...ME, unitIds: ["unit-a"], currentUnitId: "unit-a" }),
      http.get("*/api/conversations", () => HttpResponse.json([])),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().currentUnitId).toBe("unit-a");
  });
});

/**
 * Session continuity — change `session-recovery`, spec requirement of the same
 * name in `openspec/changes/session-recovery/specs/auth/spec.md`.
 *
 * These pin the defect the exploratory tours found on 2026-09-10 and hit twice,
 * an hour apart: a session that stopped being accepted was never replaced, so
 * every screen answered 401 until someone cleared browser storage by hand. The
 * scenarios below are the spec's, by title.
 *
 * Axes
 *   A7 token source — captured at boot / refreshed by the provider afterwards
 *   A8 stored session — accepted by /auth/me / refused with 401
 *   A9 refusal timing — at load (hydration) / mid-life (after a green load)
 *   A10 recovery grant — succeeds / fails
 *
 * Outputs
 *   O6 bearer on the next CRM request — the current token, never the stale one
 *   O7 grant count during one recovery — exactly one
 *   O8 screen during recovery — product route stays, no credential form
 *   O9 terminal failure — LOGIN_FAILED_COPY once, and no further grant
 *
 * Sampled-cell
 *   refreshed token   | A7 refreshed        | O6    | stale bearer kept forever
 *   refused at load   | A8 refused, A10 ok  | O6,O7 | dead session re-applied
 *   refused mid-life  | A9 mid-life         | O7,O8 | recovery needs a reload
 *   recovery fails    | A10 fails           | O9    | grant loop, or a login form
 *
 * MUTATION CHECKS (change `session-recovery`, task 4.1). All five bite. The
 * fourth did not, at first, and running that down found a real defect — see the
 * last entry, which is the most useful thing in this header.
 *
 *   Remove the `onAuthStateChange` mirroring in `AppProviders.tsx` → "uses a
 *   token the Auth provider refreshed" fails with `expected 'session-token' to
 *   be 'refreshed-token'`.
 *
 *   Remove the `reportRefusedSession()` call from `parse()` → "re-establishes a
 *   session refused mid-life without a reload" fails with `expected +0 to be 1`
 *   (no grant ever happens). Nothing else fails, which locates that route
 *   precisely: it is what carries a refusal discovered AFTER hydration.
 *
 *   Disable the loop guard in `applySession` → the unit case "does not recover
 *   again when the freshly granted token is itself refused" does not merely
 *   fail, it TIMES OUT, because `recoverSession()` ends up awaiting the very
 *   promise it is running inside. The guard is a deadlock guard as much as a
 *   loop guard.
 *
 *   Disable the plain `if (refused)` recovery branch in `applySession` → "discards
 *   a stored session" fails, because a CRM request goes out carrying the refused
 *   bearer. What the branch contributes is not the recovery — `parse()` starts
 *   that either way — but the WAITING: it awaits the recovery rather than
 *   falling through to `setState({ ready: true })` with no usable token.
 *
 *   Make the loop guard read the store's `recovering` instead of taking
 *   `duringRecovery` as an argument → "discards a stored session" fails on
 *   `recoveryFailed`. THIS IS HOW A REAL BUG WAS FOUND, and it is worth the
 *   paragraph. The mutation above originally turned nothing red, which looked
 *   like redundant code. Logging the store's whole state history instead of
 *   asserting on its final value showed why: hydration's first refusal reports
 *   through `parse()`, which sets `recovering` true while `applySession` is
 *   still awaiting `resolveUnit()`, so on resuming the FIRST refusal matched the
 *   loop guard. `recoveryFailed` — a terminal flag — latched true on a recovery
 *   that then succeeded, leaving the app one refusal away from the permanent
 *   session wall this whole change exists to close; and `recovering` was cleared
 *   mid-flight, so `RequireAuth` would show the failure copy over a session
 *   seconds from working. Every assertion in the suite stayed green throughout.
 *   The fix is to pass provenance as an argument, since it cannot be inferred
 *   from state two callers share. The lesson generalises: when a mutation does
 *   not bite, the tests may be measuring the end state of a sequence whose
 *   MIDDLE is where the behaviour lives.
 *
 * Out of scope: the real one-hour refresh interval (driven through the captured
 * subscriber instead), and everything provable without a mounted tree — the
 * grant count, the loop guard, the shared in-flight promise and the retry
 * policy all live in `AppProviders.session-recovery.test.ts`, which awaits
 * `recoverSession()` directly rather than racing it. Only the four cases here
 * need a real provider, and each pays for the mounting it does.
 */
describe("AuthHydrate session continuity", () => {
  /** Grants a session whose access token is `token`, counting the calls. */
  function grantHandler(token: string, counter: { calls: number }) {
    return http.post("*/auth/v1/token", () => {
      counter.calls += 1;
      return HttpResponse.json({
        access_token: token,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `refresh-${token}`,
        user: { id: "user-1" },
      });
    });
  }

  /** Mocks `getSession` so hydration takes the stored-session path. */
  function givenStoredSession(client: NonNullable<ReturnType<typeof getSupabaseClient>>) {
    vi.spyOn(client.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: SESSION_TOKEN } as Session },
      error: null,
    });
  }

  it("uses a token the Auth provider refreshed, not the one captured at boot", async () => {
    // Spec: Session continuity — "A refreshed token is used".
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    // Capture the subscriber AppProviders registers, so a refresh can be driven
    // deterministically rather than by waiting out the provider's real hour.
    let notify: ((event: string, session: { access_token: string } | null) => void) | undefined;
    const realSubscribe = client.auth.onAuthStateChange.bind(client.auth);
    vi.spyOn(client.auth, "onAuthStateChange").mockImplementation((callback) => {
      notify = callback as unknown as typeof notify;
      return realSubscribe(callback);
    });
    givenStoredSession(client);

    server.use(
      http.get("*/api/auth/me", () => HttpResponse.json({ unitIds: ["unit-a"] })),
      http.get("*/api/conversations", () => HttpResponse.json([])),
    );

    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(useAuthSession.getState().accessToken).toBe(SESSION_TOKEN);

    const refreshed = "refreshed-token";
    notify?.("TOKEN_REFRESHED", { access_token: refreshed });

    // The store is what `headers()` reads, so this IS the bearer every later
    // request carries. Before the subscription existed it stayed on the boot
    // token until the API refused it, with no way back.
    await waitFor(() => {
      expect(useAuthSession.getState().accessToken).toBe(refreshed);
    });
    expect(useAuthSession.getState().accessToken).not.toBe(SESSION_TOKEN);
  });

  it("discards a stored session the API refuses and signs in again once", async () => {
    // Spec: Session continuity — "A refused stored session falls back to the grant".
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    givenStoredSession(client);
    const signOut = vi.spyOn(client.auth, "signOut");

    const granted = "granted-token";
    const grants = { calls: 0 };
    const bearers: string[] = [];
    // Every state the store passes through, not just the one it ends in.
    //
    // This is what makes the case bite. A 401 on `/auth/me` reaches recovery by
    // TWO routes — hydration's own refusal branch, and `parse()` reporting it
    // through the registry — so asserting only the final bearer passes even
    // with the refusal branch disabled, and the pin proves nothing. (Checked:
    // replacing `if (refused)` with `if (false)` leaves the end state green.)
    // What the branch alone owns is the state NOT reached: it declines to set
    // `ready` while the refused token is still in the store, so the app never
    // publishes a session it has just been told is dead.
    const published: {
      ready: boolean;
      accessToken: string | null;
      recoveryFailed: boolean;
    }[] = [];
    const unsubscribe = useAuthSession.subscribe((state) => {
      published.push({
        ready: state.ready,
        accessToken: state.accessToken,
        recoveryFailed: state.recoveryFailed,
      });
    });
    server.use(
      grantHandler(granted, grants),
      // Both arms matter. If every bearer were refused, "it recovered" would be
      // indistinguishable from "nothing was ever accepted"; if none were, the
      // refusal branch would never run.
      http.get("*/api/auth/me", ({ request }) =>
        request.headers.get("authorization") === `Bearer ${SESSION_TOKEN}`
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ unitIds: ["unit-a"] }),
      ),
      http.get("*/api/conversations", ({ request }) => {
        bearers.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    await waitFor(() => expect(grants.calls).toBe(1));
    // Clearing the Auth client's own storage is what a person used to have to do
    // by hand; local scope because the session is refused here, not everywhere.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    await waitFor(() => expect(bearers.length).toBeGreaterThan(0));
    expect(bearers.every((value) => value === `Bearer ${granted}`)).toBe(true);
    assertNoLoginForm();

    unsubscribe();
    // The obvious form of this assertion — "never ready with the REFUSED token
    // in the store" — is true either way and pins nothing, because recovery
    // nulls `accessToken` synchronously the moment `parse()` reports the 401,
    // which is before `applySession` resumes from its `await`. The refused
    // string is therefore already gone.
    expect(
      published.filter((state) => state.ready && state.accessToken === SESSION_TOKEN),
    ).toEqual([]);
    // A successful recovery must never latch the terminal flag on the way
    // through. This one is not hypothetical: it shipped. The loop guard used to
    // read the store's `recovering` instead of taking provenance as an
    // argument, and hydration's own first refusal reports through `parse()`,
    // which sets `recovering` true while this call is still awaiting
    // `resolveUnit()`. The first refusal therefore looked like a failed retry,
    // so `recoveryFailed` latched true — terminal — and the session recovery
    // then established successfully could never be recovered again. The app
    // ended one refusal away from the exact wall this change exists to close,
    // and every other assertion in this test stayed green.
    expect(published.filter((state) => state.recoveryFailed)).toEqual([]);
    // This is the form that bites. The state the branch actually prevents is
    // `ready` with NO token and no terminal failure — a session declared usable
    // while recovery is still in flight, which makes `RequireAuth` swap the
    // loading state for a product route that has nothing to render yet.
    // Deleting the `if (refused)` branch produces exactly this state.
    expect(
      published.filter(
        (state) => state.ready && state.accessToken === null && !state.recoveryFailed,
      ),
    ).toEqual([]);
  });

  it("re-establishes a session refused mid-life without a reload", async () => {
    // Spec: Session continuity — "A session refused mid-life is re-established
    // without a reload".
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    givenStoredSession(client);

    const granted = "granted-after-mid-life";
    const grants = { calls: 0 };
    let refuse = false;
    // Every CRM read, tagged with whether recovery was under way when it left.
    //
    // This is the spec's "a refused session does not retry without bound", and
    // it needs stating carefully, because the obvious reading of the design
    // task — "the existing token gate stops queries firing" — turned out to be
    // wrong. There is no `enabled` gate anywhere in this app: the only thing
    // that ever stopped queries was `RequireAuth` unmounting its children when
    // `accessToken` went null, and this change deliberately STOPS it doing that
    // during a recovery so the screen does not flash. What holds instead is
    // narrower and worth naming: an idle mounted query does not refetch on its
    // own, and `retryUnlessRefused` denies the retry that would otherwise
    // multiply one 401 by the number of mounted queries.
    const crmBearers: { bearer: string | null; whileRecovering: boolean }[] = [];
    server.use(
      grantHandler(granted, grants),
      // Only the ORIGINAL session goes bad. Refusing every bearer would refuse
      // the recovery's own fresh token too, and the loop guard would then
      // correctly give up — which is a different scenario, tested below.
      http.get("*/api/auth/me", ({ request }) =>
        refuse && request.headers.get("authorization") === `Bearer ${SESSION_TOKEN}`
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ unitIds: ["unit-a"] }),
      ),
      http.get("*/api/conversations", ({ request }) => {
        crmBearers.push({
          bearer: request.headers.get("authorization"),
          whileRecovering: useAuthSession.getState().recovering,
        });
        return HttpResponse.json([]);
      }),
    );

    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(grants.calls).toBe(0);

    // The session goes bad while the app is open. Driven through a real CRM
    // read so the path under test is the production one — `parse()` seeing a
    // 401 and reporting it — rather than the recovery being called directly.
    refuse = true;
    await fetchMe().catch(() => undefined);

    await waitFor(() => expect(grants.calls).toBe(1));
    // The point of the whole change: the person keeps looking at the screen they
    // were already on, and is never asked to sign in.
    expect(screen.getByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    assertNoLoginForm();

    // Nothing went out during the recovery window, and nothing ever went out
    // unauthenticated. The second half matters as much as the first: keeping
    // the tree mounted means a refetch triggered during recovery WOULD be sent
    // with no bearer, so this is the assertion that would notice if something
    // later started refetching on an interval or on focus.
    expect(crmBearers.filter((entry) => entry.whileRecovering)).toEqual([]);
    expect(crmBearers.every((entry) => entry.bearer !== null)).toBe(true);
  });

  it("shows the failure copy once when the recovery grant also fails", async () => {
    // Spec: Session continuity — "Recovery that fails resolves to the failure copy".
    const client = getSupabaseClient();
    if (!client) {
      throw new Error("expected Auth client in vitest.env");
    }
    givenStoredSession(client);

    const grants = { calls: 0 };
    server.use(
      http.post("*/auth/v1/token", () => {
        grants.calls += 1;
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
      // Every bearer is refused, so recovery cannot succeed by accident.
      http.get("*/api/auth/me", () => new HttpResponse(null, { status: 401 })),
      http.get("*/api/conversations", () => new HttpResponse(null, { status: 401 })),
    );

    renderApp("/");

    expect(await screen.findByText(LOGIN_FAILED_COPY)).toBeInTheDocument();
    assertNoLoginForm();
    // The loop guard. Without it, the grant's own refused token would trigger
    // another recovery, and another, for as long as the tab stayed open.
    await waitFor(() => expect(useAuthSession.getState().recoveryFailed).toBe(true));
    expect(grants.calls).toBe(1);
  });
});

