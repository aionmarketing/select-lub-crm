/**
 * JWT validation adapters: Supabase in production, fixed tokens in tests.
 * `registerAuthHook` calls `GetUser`; the CRM profile and memberships come from
 * accounts' `createCallerDirectory` (`@select-lub/core/modules/accounts`).
 */

/** Minimal auth identity returned from a bearer token. */
export type AuthUser = { id: string; email: string };

/** Validates a bearer token and returns the auth user id, or null when invalid. */
export type GetUser = (token: string) => Promise<AuthUser | null>;

/** Bearer token accepted by {@link createFakeGetUser} in default test fixtures. */
export const TEST_ACCESS_TOKEN = "test-access-token";

/** Stable auth user id paired with {@link TEST_ACCESS_TOKEN}. */
export const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * In-memory token table for Vitest; defaults include {@link TEST_ACCESS_TOKEN}.
 *
 * @param users - Extra bearer-token → user mappings merged over the default test token.
 * @returns A {@link GetUser} that resolves tokens from the in-memory table.
 */
export function createFakeGetUser(users: Record<string, AuthUser | null> = {}): GetUser {
  const table: Record<string, AuthUser | null> = {
    [TEST_ACCESS_TOKEN]: { id: TEST_USER_ID, email: "attendant@example.com" },
    ...users,
  };
  return async (token) => (token in table ? table[token] : null);
}

/**
 * Validates tokens via Supabase anon/publishable key; returns null when env is unset or token is invalid.
 *
 * @returns A {@link GetUser} backed by `supabase.auth.getUser`.
 */
export function createSupabaseGetUser(): GetUser {
  return async (token) => {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !anonKey) {
      return null;
    }
    const { createClient } = await import("@supabase/supabase-js");
    const { data, error } = await createClient(url, anonKey).auth.getUser(token);
    if (error || !data.user) {
      return null;
    }
    return { id: data.user.id, email: data.user.email ?? "" };
  };
}
