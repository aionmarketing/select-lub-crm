/**
 * Zustand store for the Supabase access token, current unit, and session hydration readiness.
 */
import { create } from "zustand";

/** Fixed bearer token injected in web unit tests. */
export const TEST_WEB_ACCESS_TOKEN = "test-access-token";

/** User-facing copy when MVP auto-login fails or no session exists. */
export const LOGIN_FAILED_COPY = "Não foi possível entrar. Verifique o e-mail e a senha.";

/** Zustand hook for bearer token, active unit id, and session hydration readiness after Supabase login. */
export const useAuthSession = create<{
  accessToken: string | null;
  currentUnitId: string | null;
  ready: boolean;
  /**
   * A session is being re-established after the CRM API refused the last one.
   *
   * Distinct from `ready: false`, which means "the first hydration has not
   * finished". This one means "we had a session, it stopped working, and a
   * replacement is on its way" — and while it is true `accessToken` is null, so
   * the existing token gate stops dependent reads firing against a bearer
   * already known to be dead.
   */
  recovering: boolean;
  /**
   * Recovery was attempted and did not produce a usable session.
   *
   * The terminal state. It exists to stop the loop: without it, a grant whose
   * own fresh token is refused would trigger another recovery, forever. Once
   * set, the Portuguese failure copy is shown and no further recovery runs.
   */
  recoveryFailed: boolean;
}>(() => ({
  accessToken: null,
  currentUnitId: null,
  ready: false,
  recovering: false,
  recoveryFailed: false,
}));
