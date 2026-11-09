/**
 * Indirection that lets the HTTP layer ask for a session recovery.
 *
 * `api/http.ts` is the first place to learn that a session has gone bad — it is
 * the code that sees the 401 — but the recovery itself lives in
 * `AppProviders.tsx`, which imports the HTTP layer transitively through every
 * API module. Importing back the other way would close a cycle. A registry
 * inverts it: `AppProviders` registers its handler on mount, and `http.ts`
 * depends only on this tiny module.
 *
 * It is also what keeps `http.ts` honest about its job. The HTTP layer reports
 * that a request was refused; it does not decide what a refusal means, does not
 * know about Supabase, and cannot accidentally grow a second recovery policy.
 */

/** The registered recovery, or a no-op before `AppProviders` has mounted. */
let handler: (() => void) | undefined;

/**
 * Registers the function to call when the CRM API refuses a request.
 *
 * @param next - Recovery to run, or `undefined` to deregister on unmount.
 * @returns Nothing; replaces any previously registered handler.
 */
export function setSessionRecoveryHandler(next: (() => void) | undefined) {
  handler = next;
}

/**
 * Reports that the CRM API refused a request with 401.
 *
 * Fire-and-forget by design: the caller is `parse()`, which is about to throw
 * `http 401` at whichever query made the request, and that throw must not wait
 * on a sign-in round trip. Recovery de-duplicates itself, so calling this from
 * every refused request on a busy screen still produces one grant.
 *
 * @returns Nothing; safe to call before a handler is registered.
 */
export function reportRefusedSession() {
  handler?.();
}
