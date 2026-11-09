/**
 * The one decision create-user makes about an error: is it "that e-mail is
 * already registered"? Pure — the error arrives as an argument.
 */

/**
 * True when the identity provider reports an e-mail that is already registered.
 *
 * Supabase Auth Admin says so with `code` `email_exists` or
 * `user_already_exists`, or, on older versions, a 422 whose message mentions it.
 *
 * @param error - Whatever the create-user port threw.
 * @returns Whether the failure is a duplicate-e-mail conflict, which the route
 *   answers with 409.
 */
export function isAuthDuplicateEmail(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const status = "status" in error && typeof error.status === "number" ? error.status : 0;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (code === "email_exists" || code === "user_already_exists") {
    return true;
  }
  return status === 422 && /already|registered|exists/i.test(message);
}
