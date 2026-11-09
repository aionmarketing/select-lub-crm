/**
 * Test design (testing-strategy)
 *
 * Setup: no React. Every case here calls `recoverSession()` or
 * `retryUnlessRefused()` directly and awaits it, with MSW answering the Supabase
 * token endpoint and `GET /auth/me`.
 *
 * WHY NO MOUNTING — this is the whole point of the file. Recovery is
 * deliberately fire-and-forget: `parse()` reports a 401 and throws immediately
 * rather than making the caller wait on a sign-in, which is right in a browser
 * and poison in a test runner. A first attempt at this change verified recovery
 * by mounting the app and racing it, and a recovery started by one test settled
 * during the *next* one, writing `accessToken`, `ready`, `recovering` and
 * `recoveryFailed` into a store every test shares. The result was 5–8 failures
 * out of 646, in a set that moved between identical runs and spread into files
 * that have nothing to do with auth. That attempt was reverted; the diagnosis is
 * in `openspec/changes/session-recovery/tasks.md`.
 *
 * Awaiting the promise removes the race rather than papering over it: the write
 * lands inside the test that caused it, so a failure here is a real one and the
 * same run twice gives the same answer. The end-to-end path — a live provider,
 * a real refusal, a screen that stays up — is covered by a small number of
 * mounted cases in `AuthHydrate.test.tsx`, which is the right place for them and
 * the only place that pays the racing cost.
 *
 * Oracle: `openspec/changes/session-recovery/specs/auth/spec.md`, requirement
 * **Session continuity**. Found by the exploratory tours of 2026-09-10 —
 * `apps/e2e/test/tours/runs/2026-09-10-conversas-inbox.md` (finding 1) and
 * `2026-09-10-follow-up.md` (finding 2), rolled up as **D2**.
 *
 * THE DEFECT, as observed. After roughly an hour — the Supabase access-token
 * lifetime — every CRM call answered 401. The inbox emptied, Follow-up counts
 * rendered `—`, and React Query retried without bound (console errors climbed
 * 6 → 188 in about three minutes of idling). Reloading did not recover:
 * `hydrateMvpSession` took any stored `access_token` on trust and returned
 * before the password-grant fallback, so the same dead token was re-applied on
 * every boot. The only recovery was clearing `sb-*-auth-token` by hand.
 *
 * Axes
 *   A1 recovery grant — succeeds / fails / credentials missing
 *   A2 the fresh token — accepted by `/auth/me` / refused by it too
 *   A3 concurrency — one caller / several at once
 *   A4 prior outcome — first attempt / already failed terminally
 *   A5 retry input — `http 401` / another error, first failure / second
 *
 * Outputs
 *   O1 store after the attempt (`accessToken`, `ready`, `recovering`, `recoveryFailed`)
 *   O2 `POST /auth/v1/token` count — exactly one, never zero, never a loop
 *   O3 `retryUnlessRefused` verdict
 *
 * Sampled-cell
 *   grant succeeds        | A1 ok, A2 accepted  | O1,O2 | dead token re-applied
 *   grant fails           | A1 fails            | O1    | stuck with no failure copy
 *   fresh token refused   | A2 refused          | O1,O2 | recovery loops forever
 *   three concurrent      | A3 several          | O2    | one grant per refused request
 *   already failed        | A4 terminal         | O2    | loop after a hard failure
 *   401 vs transient      | A5                  | O3    | 401 storm across mounted queries
 *
 * Out of scope: the 8-second unit-read deadline (specified and covered by
 * `AuthHydrate.test.tsx`), replacing MVP auto-login with a real login form, and
 * the machine-clock error seen during the drive — owner-confirmed local clock
 * skew, not a product issue.
 */
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recoverSession,
  resetSessionRecoveryForTests,
  retryUnlessRefused,
  settleSessionRecoveryForTests,
} from "./AppProviders.js";
import { useAuthSession } from "./authSession.js";
import { reportRefusedSession, setSessionRecoveryHandler } from "./sessionRecovery.js";
import { getSupabaseClient } from "./supabaseClient.js";
import { server } from "../test/msw/server.js";

const FRESH_TOKEN = "fresh-token";
const ME_BODY = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "attendant@example.com",
  name: "Atendente",
  unitIds: ["unit-a"],
  currentUnitId: "unit-a",
};

/**
 * Counts password grants and answers them with `FRESH_TOKEN`.
 *
 * @param counter - Mutable box the handler increments once per grant.
 * @param ok - Whether the grant succeeds; `false` answers `invalid_grant`.
 * @returns An MSW handler for `POST /auth/v1/token`.
 */
function grantHandler(counter: { count: number }, ok = true) {
  return http.post("*/auth/v1/token", () => {
    counter.count += 1;
    if (!ok) {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    return HttpResponse.json({
      access_token: FRESH_TOKEN,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "refresh-token",
      user: { id: "user-1", aud: "authenticated", role: "authenticated", email: ME_BODY.email },
    });
  });
}

/** Answers `GET /auth/me` with a membership, or with `status` when given a number. */
function meHandler(status?: number) {
  return http.get("*/api/auth/me", () =>
    status === undefined
      ? HttpResponse.json(ME_BODY)
      : HttpResponse.json({ error: "refused" }, { status }),
  );
}

/** Keeps `signOut({ scope: "local" })` off the network so the cases stay hermetic. */
function logoutHandler() {
  return http.post("*/auth/v1/logout", () => new HttpResponse(null, { status: 204 }));
}

beforeEach(async () => {
  resetSessionRecoveryForTests();
  useAuthSession.setState({
    accessToken: "stale-token",
    currentUnitId: null,
    ready: true,
    recovering: false,
    recoveryFailed: false,
  });
  const client = getSupabaseClient();
  if (client) {
    await client.auth.signOut({ scope: "local" });
  }
  localStorage.clear();
});

afterEach(async () => {
  await settleSessionRecoveryForTests();
});

describe("recoverSession", () => {
  it("replaces a refused session with a freshly granted one", async () => {
    const grants = { count: 0 };
    server.use(logoutHandler(), grantHandler(grants), meHandler());

    await recoverSession();

    expect(grants.count).toBe(1);
    expect(useAuthSession.getState()).toMatchObject({
      accessToken: FRESH_TOKEN,
      currentUnitId: "unit-a",
      ready: true,
      recovering: false,
      recoveryFailed: false,
    });
  });

  it("nulls the refused token before granting, so nothing reuses a dead bearer", async () => {
    const grants = { count: 0 };
    const bearersSeen: (string | null)[] = [];
    server.use(
      logoutHandler(),
      grantHandler(grants),
      http.get("*/api/auth/me", ({ request }) => {
        bearersSeen.push(request.headers.get("authorization"));
        return HttpResponse.json(ME_BODY);
      }),
    );

    await recoverSession();

    // The point of ordering the writes: the unit read that recovery itself
    // performs must already be carrying the NEW bearer. Seeing "stale-token"
    // here would mean the store was still publishing a token the API refuses.
    expect(bearersSeen).toEqual([`Bearer ${FRESH_TOKEN}`]);
  });

  it("issues exactly one grant when several refused requests report at once", async () => {
    const grants = { count: 0 };
    server.use(logoutHandler(), grantHandler(grants), meHandler());

    // The realistic shape of a refusal: a populated screen has several requests
    // in flight, they are all refused together, and each one reports it.
    await Promise.all([recoverSession(), recoverSession(), recoverSession()]);

    expect(grants.count).toBe(1);
    expect(useAuthSession.getState().accessToken).toBe(FRESH_TOKEN);
  });

  it("resolves to the failure state when the grant is refused", async () => {
    const grants = { count: 0 };
    server.use(logoutHandler(), grantHandler(grants, false), meHandler());

    await recoverSession();

    expect(grants.count).toBe(1);
    expect(useAuthSession.getState()).toMatchObject({
      accessToken: null,
      ready: true,
      recovering: false,
      recoveryFailed: true,
    });
  });

  it("does not recover again when the freshly granted token is itself refused", async () => {
    const grants = { count: 0 };
    server.use(logoutHandler(), grantHandler(grants), meHandler(401));

    await recoverSession();

    // The loop guard. A fresh credential-grant token that the API rejects is
    // not going to be fixed by granting another, so this must terminate rather
    // than recover again — and it must not deadlock awaiting the very promise
    // it is running inside.
    expect(grants.count).toBe(1);
    expect(useAuthSession.getState()).toMatchObject({
      accessToken: null,
      ready: true,
      recovering: false,
      recoveryFailed: true,
    });
  });

  it("stands down once recovery has already failed terminally", async () => {
    const grants = { count: 0 };
    server.use(logoutHandler(), grantHandler(grants), meHandler());
    useAuthSession.setState({ recoveryFailed: true });

    await recoverSession();

    expect(grants.count).toBe(0);
  });

  it("keeps recovering true for the whole attempt, so the screen is not shown a failure", async () => {
    const grants = { count: 0 };
    const flagDuringGrant: boolean[] = [];
    server.use(
      logoutHandler(),
      http.post("*/auth/v1/token", () => {
        flagDuringGrant.push(useAuthSession.getState().recovering);
        grants.count += 1;
        return HttpResponse.json({
          access_token: FRESH_TOKEN,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "refresh-token",
          user: {
            id: "user-1",
            aud: "authenticated",
            role: "authenticated",
            email: ME_BODY.email,
          },
        });
      }),
      meHandler(),
    );

    await recoverSession();

    // Sampled mid-flight rather than after: `recovering` is what stops
    // `RequireAuth` flashing the Portuguese failure copy at somebody whose
    // session is seconds from being restored, and it is only load-bearing
    // during the window this asserts on.
    expect(flagDuringGrant).toEqual([true]);
    expect(useAuthSession.getState().recovering).toBe(false);
  });
});

describe("the refusal registry", () => {
  it("is safe to report a refusal before any provider has registered", () => {
    setSessionRecoveryHandler(undefined);

    // `parse()` calls this on every 401, including ones raised before the app
    // has mounted; it must not turn a 401 into a crash.
    expect(() => reportRefusedSession()).not.toThrow();
  });

  it("routes a reported refusal to the registered handler, then stops on deregister", () => {
    let calls = 0;
    setSessionRecoveryHandler(() => {
      calls += 1;
    });
    reportRefusedSession();
    setSessionRecoveryHandler(undefined);
    reportRefusedSession();

    expect(calls).toBe(1);
  });
});

describe("retryUnlessRefused", () => {
  it("never retries a refused request", () => {
    // Retrying a refused token cannot succeed — the token is no better the
    // second time — and the cost is one wasted request per mounted query, which
    // is how a dead session became a storm rather than a stale screen.
    expect(retryUnlessRefused(0, new Error("http 401"))).toBe(false);
  });

  it("keeps the single retry for anything that might be transient", () => {
    expect(retryUnlessRefused(0, new Error("http 500"))).toBe(true);
    expect(retryUnlessRefused(1, new Error("http 500"))).toBe(false);
    expect(retryUnlessRefused(0, new Error("Failed to fetch"))).toBe(true);
  });

  it("does not mistake a non-Error rejection for a refusal", () => {
    // Defensive: a thrown string reaching the retry policy must not be read as
    // a 401 by accident, which would silently disable the retry for it.
    expect(retryUnlessRefused(0, "http 401")).toBe(true);
  });
});
