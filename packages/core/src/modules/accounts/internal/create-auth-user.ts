/**
 * The identity provider's "create a user" port, and its two adapters.
 *
 * `POST /users` creates the login in Supabase Auth first and the CRM profile
 * second, so the provider call is a port: production passes
 * {@link createSupabaseCreateAuthUser}, a test passes a function that returns an
 * id. The composition root hands the chosen instance to
 * `createHttpPlugin({ createAuthUser })`; nothing here is bound globally, so two
 * apps built side by side never share one.
 *
 * Moved from `apps/api/src/auth/admin.ts` (wave 2 correction W2-C3).
 * `isAuthDuplicateEmail` did not come with it: only `create-user` reads it, and
 * as a pure rule it now lives in that slice's `rules.ts`.
 */
import { randomUUID } from "node:crypto";

/** Env var name for the Supabase service role key used to create auth users. */
export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/** Creates an identity-provider user and returns its id, which the CRM profile reuses. */
export type CreateAuthUser = (input: { email: string; password: string }) => Promise<{ id: string }>;

/**
 * Returns a fixed or random id without calling Supabase — for tests.
 *
 * @param id - Auth user id to return on every call; defaults to a new random UUID.
 * @returns A {@link CreateAuthUser} that always resolves to `{ id }`.
 */
export function createFakeCreateAuthUser(id = randomUUID()): CreateAuthUser {
  return async () => ({ id });
}

/**
 * Calls Supabase Auth Admin `createUser`; requires `SUPABASE_URL` and {@link SERVICE_ROLE_ENV}.
 *
 * @returns A {@link CreateAuthUser} that creates confirmed auth users via the service role key.
 * @throws When `SUPABASE_URL` or {@link SERVICE_ROLE_ENV} is unset, or Supabase returns an error.
 */
export function createSupabaseCreateAuthUser(): CreateAuthUser {
  return async ({ email, password }) => {
    const url = process.env.SUPABASE_URL;
    const serviceRole = process.env[SERVICE_ROLE_ENV];
    if (!url || !serviceRole) {
      throw new Error(`${SERVICE_ROLE_ENV} is required on the API to create users`);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const { data, error } = await createClient(url, serviceRole).auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw error ?? new Error("Auth admin createUser returned no user");
    }
    return { id: data.user.id };
  };
}
