/**
 * Where a tour signs in — a LOCAL Supabase Auth, as a committed test user.
 * Side-effect free, like `tour-provider-env.ts`, so
 * `test/tour-auth-guard.test.ts` can read exactly what the tour processes get
 * without loading the repository `.env`.
 *
 * Until 2026-10-04 the tours signed in with the `.env`'s `VITE_MVP_LOGIN_*`
 * against the production Supabase project, and the tour API verified every
 * token against it — so each run sent the real login off the machine, and an
 * agent with no `.env` could not run a tour at all. Now `pnpm
 * tours:supabase:start` serves Auth on {@link TOUR_SUPABASE_URL} and every
 * Supabase / login name a tour process could inherit is overridden by
 * {@link tourAuthEnv}. OpenSpec: `tours-local-supabase`.
 */

/**
 * The local Supabase gateway `apps/e2e/supabase/config.toml` publishes
 * (`[api] port`). A constant, not an inherited variable, so nothing in the shell
 * or the `.env` can redirect a tour's sign-in.
 */
export const TOUR_SUPABASE_URL = "http://127.0.0.1:54321";

/**
 * The only account a tour signs in as. It exists only in the local Auth
 * container, so these values open nothing outside this machine — which is why
 * they may be committed. `local-supabase.ts` creates it with this exact id, and
 * the database seed links the same id to the `Select Lub` unit through
 * `SEED_USER_A_ID`, as it does for the hosted attendant.
 */
export const TOUR_TEST_USER = Object.freeze({
  id: "7a5e0c1d-70a5-4c0a-9b1e-70a75e000001",
  email: "tour-attendant@selectlub.test",
  password: "tour-local-only-1",
});

/** Hostnames that mean "this machine" for an auth endpoint, as `URL.hostname` spells them. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a browser request is aimed at a hosted Supabase project.
 *
 * Every tour records such a request as a violation (`test/tours/fixtures.ts`;
 * spec scenario "A browser request to a hosted Supabase fails the tour"). That
 * sees the SPA's own sign-in and token refresh; the API's verification is
 * server-side and is covered by the env check in `test/tour-auth-guard.test.ts`,
 * which a browser listener cannot replace.
 *
 * @param url - The request URL.
 * @returns True for `*.supabase.co` and `*.supabase.com` hosts.
 */
export function isHostedSupabaseRequest(url: string): boolean {
  const { hostname } = new URL(url);
  return /(?:^|\.)supabase\.(?:co|com)$/i.test(hostname);
}

/** What the local stack must supply; the URL defaults to {@link TOUR_SUPABASE_URL}. */
export type TourAuthOptions = {
  /** The local anon key, read from `supabase status -o json` at run time. */
  anonKey: string;
  /**
   * The LOCAL service-role key, from the same status. The tour API needs one:
   * `POST /users` creates the Auth user with it, and the Usuarios tours drive
   * that route. Before tours-local-supabase that was the `.env`'s hosted key,
   * so those tours called the production Auth admin API.
   */
  serviceRoleKey: string;
  /** Override for the local gateway. Must have a loopback host. */
  url?: string;
};

/**
 * Every Supabase, login and seed-user variable a tour process could inherit,
 * set to the local stack's value. Spread or assigned LAST, over the inherited
 * env, so whatever the shell or `.env` says about these names loses.
 *
 * The service-role key is the LOCAL stack's (the CLI's public demo value), so
 * the tour API's user creation lands in the local Auth; it has no `VITE_`
 * prefix and never reaches the browser. `VITE_SUPABASE_DB_PASSWORD` is blanked
 * because any `VITE_` name reaches the browser bundle.
 *
 * @param options - The local anon and service-role keys, and optionally a loopback URL.
 * @returns A fresh object of env overrides.
 * @throws When the URL's host is not a loopback, or either key is blank.
 */
export function tourAuthEnv(options: TourAuthOptions): Record<string, string> {
  const url = options.url ?? TOUR_SUPABASE_URL;
  const hostname = new URL(url).hostname;
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(`tour auth: refusing Supabase host ${hostname} — tours sign in to a loopback Supabase only`);
  }
  if (!options.anonKey) {
    throw new Error("tour auth: no local anon key — start local Supabase with `pnpm tours:supabase:start`");
  }
  if (!options.serviceRoleKey) {
    throw new Error("tour auth: no local service-role key — start local Supabase with `pnpm tours:supabase:start`");
  }
  return {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: options.anonKey,
    SUPABASE_PUBLISHABLE_KEY: options.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: options.serviceRoleKey,
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: options.anonKey,
    VITE_SUPABASE_DB_PASSWORD: "",
    VITE_MVP_LOGIN_EMAIL: TOUR_TEST_USER.email,
    VITE_MVP_LOGIN_PASSWORD: TOUR_TEST_USER.password,
    SEED_USER_A_ID: TOUR_TEST_USER.id,
    // The attendant-b isolation user lives only in the hosted Auth; a stale
    // uuid here would seed a CRM user no local token can ever be.
    SEED_USER_B_ID: "",
  };
}
