/**
 * Top-level providers: TanStack Query, MUI theme from {@link usePalette}, and MVP auth hydration.
 */
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchMe } from "./api/auth.js";
import { useAuthSession } from "./authSession.js";
import { usePalette } from "./paletteStore.js";
import { setSessionRecoveryHandler } from "./sessionRecovery.js";
import { getSupabaseClient } from "./supabaseClient.js";
import { createAppTheme } from "./theme.js";

/**
 * How long hydration waits for `GET /auth/me` before giving up on the unit.
 *
 * This read gates `ready`, so the ceiling is what a user would stare at a
 * loading screen for, not what the request might plausibly need. Eight seconds
 * is generous for a call that does no real work on the API side, and expiring
 * it costs only the unit name: the session itself is already verified.
 */
export const ME_TIMEOUT_MS = 8000;

/**
 * TanStack Query retry policy: one retry for anything transient, none for 401.
 *
 * Retrying a refused token cannot succeed — the token is no better the second
 * time — and the cost is not one wasted request but one per mounted query, which
 * is how a dead session became a request storm instead of a stale screen.
 * Recovery is already running by the time this is consulted, and the queries
 * refetch on their own once a working token lands.
 *
 * Exported so the policy can be tested as the small decision it is, rather than
 * by mounting a screen and counting network calls.
 *
 * @param failureCount - How many times this query has already failed.
 * @param error - The failure; a refused request carries `http 401` from `parse`.
 * @returns Whether TanStack Query should try again.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  if (error instanceof Error && error.message === "http 401") {
    return false;
  }
  return failureCount < 1;
}

/** Rejects after `ms`, and hands back the handle so the winner can cancel it. */
function rejectAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("auth/me timed out")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Reads the current unit for the signed-in token from `GET /auth/me`.
 *
 * The API resolves it from the caller's memberships, so the value is a
 * membership by construction and can never trip the 403 the auth spec requires
 * for a non-membership `x-unit-id`. `currentUnitId` comes back only when the
 * user holds exactly one unit (no `x-unit-id` is sent yet on this call), so a
 * multi-unit user falls back to their first membership until a unit switcher
 * exists.
 *
 * @param timeoutMs - How long to wait before abandoning the read; defaults to
 *   {@link ME_TIMEOUT_MS}. Parameterised so a test can prove the deadline fires
 *   without spending the real one.
 * @returns The unit id to scope requests with, or null when `/auth/me` fails,
 *   times out, or the user holds no units; a null id means no `x-unit-id`
 *   header is sent.
 */
export async function resolveCurrentUnitId(
  timeoutMs: number = ME_TIMEOUT_MS,
): Promise<string | null> {
  return (await resolveUnit(timeoutMs)).unitId;
}

/**
 * The same read as {@link resolveCurrentUnitId}, but able to say *why* it failed.
 *
 * Hydration needs a distinction the public helper deliberately hides. To every
 * other caller a failed `/auth/me` is just "no unit, carry on"; to hydration a
 * **401** is different in kind, because it means the token itself is refused
 * rather than the unit merely being unknown, and that is the one case where the
 * right response is to throw the session away and sign in again. A timeout must
 * NOT trigger that — it costs only the unit, exactly as the auth spec's
 * "Expiry does not cost the session" scenario requires.
 *
 * Kept internal, and the public signature kept intact, so existing callers and
 * their tests are untouched.
 *
 * @param timeoutMs - How long to wait before abandoning the read.
 * @returns The unit id (or null), plus whether the read was refused with 401.
 */
async function resolveUnit(
  timeoutMs: number = ME_TIMEOUT_MS,
): Promise<{ unitId: string | null; refused: boolean }> {
  // The deadline is what makes the catch below sufficient. `fetch` never times
  // out on its own, so an API that accepts the connection and then never
  // answers would leave this promise pending, `ready` unwritten, and the app
  // parked on "Carregando…" with no way out — a hang no catch can see, because
  // nothing ever rejects. Racing a timer converts that hang into a rejection.
  //
  // This races rather than passing `AbortSignal.timeout` to `fetch`, so the
  // request is abandoned rather than cancelled. Two reasons. The signal is not
  // testable here: under vitest's jsdom the global `AbortSignal` is a different
  // realm's class from the one Node's `fetch` accepts, so passing one throws
  // `TypeError: Expected signal to be an instance of AbortSignal` — which this
  // very catch would swallow into a null unit, disabling the feature under test
  // while it still worked in a browser. And cancelling buys nothing anyway: the
  // abandoned request is one idempotent GET whose body we simply ignore.
  const deadline = rejectAfter(timeoutMs);
  try {
    const me = await Promise.race([fetchMe(), deadline.promise]);
    return { unitId: me.currentUnitId ?? me.unitIds[0] ?? null, refused: false };
  } catch (error) {
    // A failed or timed-out /auth/me must not strand the app. Without an id the
    // header is omitted and the API scopes a single-unit user anyway.
    //
    // The one failure worth telling apart is a 401: `parse()` throws
    // `http 401`, and that says the TOKEN is refused, not that the unit is
    // unknown. Matched on the message because that is the contract `parse()`
    // offers; a timeout rejects with "auth/me timed out" and so reports
    // `refused: false`, which keeps a slow read costing only the unit.
    const refused = error instanceof Error && error.message === "http 401";
    return { unitId: null, refused };
  } finally {
    // Clears the timer when the fetch won, so a rejection cannot surface after
    // the race is already settled and no timer outlives the hydrate.
    deadline.cancel();
  }
}

/**
 * Writes a verified token, then the unit it resolves to, and marks the session ready.
 *
 * The two writes are ordered: `headers()` in `api/http.ts` reads the token out
 * of this same store, so `GET /auth/me` cannot be sent before `accessToken`
 * lands. `ready` flips only after the unit is known, because a user with more
 * than one membership gets 403 on every unit-scoped route until `x-unit-id` is
 * being sent.
 *
 * @param accessToken - Verified Supabase access token for the new session.
 * @param duringRecovery - Whether this call is the one {@link recoverSession}
 *   makes with its freshly granted token. Only that caller may treat a refusal
 *   as terminal; every other caller's refusal is a first refusal and must be
 *   recovered from. Passed rather than read off the store, because by the time
 *   this resumes from its `await` a concurrent recovery may already have set
 *   `recovering` — which made the first refusal look like a failed retry.
 * @returns Resolves once `currentUnitId` and `ready` are written.
 */
async function applySession(accessToken: string, duringRecovery = false) {
  useAuthSession.setState({ accessToken, currentUnitId: null });
  const { unitId, refused } = await resolveUnit();
  if (refused && duringRecovery) {
    // The loop guard, and also a deadlock guard. We are already inside
    // `recoverSession()`: it signed out, ran the grant, and the brand-new token
    // it produced has *also* been refused. Calling `recoverSession()` again
    // would return the very promise this call stack is running inside and await
    // it forever. There is nothing left to try — a fresh credential-grant token
    // that the API rejects is not going to be fixed by granting another — so
    // this resolves to the terminal failure the spec asks for: the Portuguese
    // copy once, no credential form, and no further CRM requests.
    //
    // `duringRecovery` is a PARAMETER, not the store's `recovering` flag, and
    // that distinction is the whole correctness of this branch. Reading the
    // store here was wrong and shipped briefly: hydration's own first refusal
    // travels through `parse()`, which starts a recovery and sets `recovering`
    // true *while this function is still awaiting `resolveUnit()`*. On resuming,
    // the very first refusal therefore looked like a failed retry. The damage
    // was quiet and severe — `recoveryFailed` latched true, which is terminal,
    // so the session that recovery then established successfully could never be
    // recovered again; and `recovering` was cleared while a recovery was still
    // in flight, so `RequireAuth` showed the failure copy over a session that
    // was seconds from working. Provenance cannot be inferred from shared
    // state; it has to be passed.
    useAuthSession.setState({
      recovering: false,
      ready: true,
      accessToken: null,
      recoveryFailed: true,
    });
    return;
  }
  if (refused) {
    // Pinned by "discards a stored session the API refuses and signs in again
    // once" in `AuthHydrate.test.tsx`: deleting this branch sends a CRM request
    // carrying the refused bearer, and that assertion goes red.
    //
    // It briefly looked redundant with the `parse()` route, since a 401 on
    // `GET /auth/me` reaches recovery either way, and for a while no test could
    // tell the difference. That was a gap in the tests rather than in the code,
    // and chasing it is what uncovered the loop-guard provenance bug above.
    // What this branch adds is not the recovery but the WAITING: it awaits the
    // recovery instead of falling through to `setState({ ready: true })`, so
    // nothing downstream is told the session is usable while a replacement is
    // still being fetched.
    //
    // The token is not merely short of a unit — the API will not accept it. A
    // stored session that reaches this point is what used to strand the app:
    // `getSession()` handed back a dead token, hydration applied it, and every
    // screen 401'd forever because the grant fallback sat behind an
    // `if (existing)` that had already returned. Recovering here is what makes
    // "a stored session the CRM API refuses is not an existing session" true.
    //
    // `ready` is deliberately NOT set: recovery owns the readiness flag from
    // here, and flipping it now would let dependent reads fire against the
    // token we just decided to discard.
    await recoverSession();
    return;
  }
  useAuthSession.setState({ currentUnitId: unitId, ready: true });
}

/**
 * Signs in with an existing session or `VITE_MVP_LOGIN_*` once, then marks {@link useAuthSession} ready.
 *
 * @returns Resolves after `accessToken`, `currentUnitId` and `ready` are written; never throws (catch sets `ready` with a null token and no unit).
 */
async function hydrateMvpSession() {
  const client = getSupabaseClient();
  if (!client) {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    return;
  }
  try {
    const { data } = await client.auth.getSession();
    const existing = data.session?.access_token;
    if (existing) {
      await applySession(existing);
      return;
    }
    await establishSession(client);
  } catch {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
  }
}

/**
 * Runs the password grant and applies the session it returns.
 *
 * The grant half of {@link hydrateMvpSession}, lifted out so that recovery can
 * reuse it rather than reimplement it — the two paths must agree about what a
 * successful sign-in looks like, and the cheapest way to guarantee that is for
 * there to be one of them.
 *
 * @param client - Supabase client to sign in with.
 * @returns `true` when a session was applied, `false` when the grant could not
 *   produce one (missing credentials, refused credentials, or no session in an
 *   otherwise successful response). Never throws.
 */
async function establishSession(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  duringRecovery = false,
) {
  const email = import.meta.env["VITE_MVP_LOGIN_EMAIL"];
  const password = import.meta.env["VITE_MVP_LOGIN_PASSWORD"];
  if (!email || !password) {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    return false;
  }
  const { data: signedIn, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !signedIn.session) {
    useAuthSession.setState({ accessToken: null, currentUnitId: null, ready: true });
    return false;
  }
  await applySession(signedIn.session.access_token, duringRecovery);
  return true;
}

/**
 * One in-flight recovery, shared by every caller that notices a refusal.
 *
 * Load-bearing. A refused session is discovered by whichever CRM request
 * happens to answer first, and on a populated screen that is several at once;
 * without this they would each start their own grant. Cleared when the attempt
 * settles so a genuinely later refusal can recover again.
 */
let recoveryInFlight: Promise<void> | undefined;

/**
 * Clears the shared in-flight recovery. For tests only.
 *
 * Module state outlives a test, and a recovery left mid-flight by one case is
 * silently reused by the next — which turns a suite into an order-dependent one
 * and hides real failures behind "it passed alone". Mirrors the existing
 * `resetSupabaseClientCache` seam rather than inventing a new convention.
 *
 * @returns Nothing; the next `recoverSession()` starts fresh.
 */
export function resetSessionRecoveryForTests() {
  recoveryInFlight = undefined;
}

/**
 * Waits for any in-flight recovery to finish, then clears it. For tests only.
 *
 * Recovery is deliberately fire-and-forget — `parse()` reports a refusal and
 * throws immediately rather than making the caller wait on a sign-in. That is
 * right in a browser and poison in a test runner: a recovery started by one test
 * settles during the *next* one and writes `accessToken`, `ready` and
 * `recoveryFailed` into a store that test is relying on, producing failures that
 * move between runs and vanish when the test is run alone.
 *
 * Awaiting in `afterEach` closes that window: the write lands while the test
 * that caused it is still the current one.
 *
 * @returns Resolves once no recovery is outstanding.
 */
export async function settleSessionRecoveryForTests(): Promise<void> {
  await recoveryInFlight?.catch(() => undefined);
  recoveryInFlight = undefined;
}

/**
 * Discards a session the CRM API refused and signs in again, once.
 *
 * The order matters. `accessToken` is nulled *first* so that the existing token
 * gate in the query layer stops dependent reads dead rather than letting them
 * retry against a bearer already known to be refused — that unbounded retry was
 * half of the original defect, and the 401 storm it produced was what made the
 * app unusable rather than merely stale. `signOut({ scope: "local" })` then
 * clears the Auth client's own storage, which is what a person previously had to
 * do by hand; it is local because the session is refused here, not everywhere,
 * and there is no reason to invalidate it on other devices.
 *
 * @returns Resolves when the attempt has settled, successfully or not.
 */
export async function recoverSession(): Promise<void> {
  if (useAuthSession.getState().recoveryFailed) {
    return;
  }
  recoveryInFlight ??= (async () => {
    try {
      const client = getSupabaseClient();
      if (!client) {
        useAuthSession.setState({ accessToken: null, ready: true, recoveryFailed: true });
        return;
      }
      useAuthSession.setState({ accessToken: null, recovering: true });
      await client.auth.signOut({ scope: "local" });
      const established = await establishSession(client, true);
      useAuthSession.setState(
        established
          ? { recovering: false }
          : { recovering: false, ready: true, accessToken: null, recoveryFailed: true },
      );
    } catch {
      useAuthSession.setState({
        recovering: false,
        ready: true,
        accessToken: null,
        recoveryFailed: true,
      });
    } finally {
      recoveryInFlight = undefined;
    }
  })();
  return recoveryInFlight;
}

/**
 * Runs {@link hydrateMvpSession} once on mount, then renders children without waiting.
 *
 * @param children - Routed tree shown immediately; queries that need a token wait on `ready`.
 * @returns `children` unchanged.
 */
function AuthHydrate({ children }: { children: ReactNode }) {
  const hasRunRef = useRef(false);
  // Whether THIS provider established the session, and so is the one that may
  // replace it. Scope is deliberately narrow: it gates RECOVERY only, not the
  // token mirroring below — see the comment on that effect for why the wider
  // version of this gate was wrong and what it would have cost.
  //
  // The early return below already existed: a provider that mounts to find
  // `ready` already true stands down, because somebody else owns the session.
  // Token mirroring and recovery follow the same rule, and for the same reason
  // — recovering a session you did not establish is incoherent. You do not know
  // how it was made, and `establishSession()` would replace it with a
  // `VITE_MVP_LOGIN_*` grant that may be a different user entirely.
  //
  // In the browser this is always true: nothing sets `ready` before the first
  // hydration, so the app always owns its session. It is false only where some
  // other party has supplied one — which in practice means unit tests, whose
  // `setupTests.ts` seeds a fixed bearer. That is not an accident to work
  // around but the correct reading: those tests are not exercising the session
  // lifecycle, and a recovery firing inside them would replace their fixture
  // with a real grant mid-assertion.
  const [ownsSession, setOwnsSession] = useState(false);
  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    hasRunRef.current = true;
    if (useAuthSession.getState().ready) {
      return;
    }
    setOwnsSession(true);
    void hydrateMvpSession();
  }, []);

  // Keep the stored bearer equal to the Auth client's CURRENT token, not the
  // one captured when the session was first applied. The client is created with
  // `autoRefreshToken: true`, so it quietly replaces its own token about once an
  // hour; without this subscription the app went on sending the boot-time
  // string until the API refused it, and then had no way back. That is the
  // session wall the exploratory tours hit twice on 2026-09-10.
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      return;
    }
    const { data } = client.auth.onAuthStateChange((event, session) => {
      // Deliberately NOT every event. `INITIAL_SESSION` fires on subscribe and
      // carries whatever is in storage — including a session the CRM API is
      // about to refuse — so mirroring it would publish a token hydration has
      // not validated yet, which is the exact bearer this change exists to stop
      // sending. These three are the ones that mean the token genuinely changed.
      if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN" && event !== "SIGNED_OUT") {
        return;
      }
      useAuthSession.setState({ accessToken: session?.access_token ?? null });
    });
    return () => data.subscription.unsubscribe();
    // Deliberately NOT gated on `ownsSession`, unlike the recovery handler
    // below, and the asymmetry is the point. Recovery is gated because
    // recovering a session you did not establish is incoherent — it would
    // substitute a `VITE_MVP_LOGIN_*` grant for possibly a different user.
    // Mirroring has no such problem: reflecting the Auth client's CURRENT token
    // is correct no matter who established it, since it is the same client the
    // session came from.
    //
    // Gating it as well was the first shape of this code, on the assumption
    // that mirroring would clobber the hand-seeded fixtures in the ~25 test
    // files that mount this provider for its theme and query client. Session
    // `local_ccd08bdb` audited that assumption and it was false: only the two
    // session-lifecycle suites call any Supabase auth method, so in the others
    // no `SIGNED_IN`, `TOKEN_REFRESHED` or `SIGNED_OUT` ever fires and the
    // subscription is inert. `INITIAL_SESSION` does fire, and is filtered above.
    // Removing the gate keeps the suite at 662/0.
    //
    // It matters because the gate was not free. `ownsSession` stays false
    // forever when `ready` is already true at first mount, so any future path
    // that pre-seeds the store — rehydration, a second provider, SSR — would
    // have silently disarmed the hourly token refresh and quietly reopened the
    // exact session wall this change closes. Ungating removes that failure mode
    // by construction, which is better than warning about it.
  }, []);

  // Lets the HTTP layer report a refusal without importing this module back.
  // Registered here rather than at module scope so it is torn down with the
  // provider, and so a test that mounts and unmounts leaves nothing behind.
  useEffect(() => {
    if (!ownsSession) {
      return;
    }
    setSessionRecoveryHandler(() => {
      void recoverSession();
    });
    return () => setSessionRecoveryHandler(undefined);
  }, [ownsSession]);

  return children;
}

/**
 * Wraps the app with TanStack Query, MUI theme, baseline CSS, and MVP session bootstrap.
 *
 * @param children - Routed SPA tree rendered inside providers.
 * @param queryClient - Optional shared `QueryClient` for tests; a default client is created when omitted.
 * @returns Provider stack that hydrates auth before rendering `children`.
 */
export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [client] = useState(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            // One retry for anything that might be transient, and none at all
            // for a 401. Retrying a refused token cannot succeed — the token is
            // no better the second time — and on a populated screen the retries
            // multiply by the number of mounted queries, which is how a dead
            // session turned into a request storm rather than a stale page.
            // Recovery is already under way by the time this runs; the queries
            // will refetch when a working token lands.
            retry: retryUnlessRefused,
          },
        },
      }),
  );
  const paletteId = usePalette((s) => s.paletteId);
  const theme = useMemo(() => createAppTheme(paletteId), [paletteId]);
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AuthHydrate>{children}</AuthHydrate>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
