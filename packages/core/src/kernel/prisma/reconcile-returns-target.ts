/**
 * Whether `db:reconcile-returns` may run against the `DATABASE_URL` it was given,
 * and the line it prints either way.
 *
 * The script exists for production: the one-open-return-per-vehicle migration
 * refuses to apply while a vehicle holds OPEN returns from different services,
 * and names this script as the fix. So, unlike `db:seed`, a remote host is
 * allowed. What is refused is an unset, blank or unreadable `DATABASE_URL`: the
 * script reads no `.env`, so the operator must name the database in the shell,
 * and it always says which host it is writing to. The host comes from the shared
 * {@link resolveDatabaseTarget}, never from splitting the URL on `@`.
 */
import { describeDatabaseTarget, resolveDatabaseTarget } from "./database-target.js";

/** The decision, with the message to print. */
export type ReconcileReturnsTarget =
  | { kind: "allowed"; url: string; message: string }
  | { kind: "refused"; message: string };

/**
 * Decides whether the script may run.
 *
 * @param env - Where `DATABASE_URL` is read; the process environment in the script.
 * @returns `allowed` with the URL and a `writing to <host>` line, or `refused`
 *   naming what is wrong.
 */
export function resolveReconcileReturnsTarget(env: {
  readonly DATABASE_URL?: string | undefined;
}): ReconcileReturnsTarget {
  const target = resolveDatabaseTarget(env);
  if (target.kind === "absent" || target.kind === "unparseable") {
    return {
      kind: "refused",
      message:
        `reconcile-returns: refusing to run — ${describeDatabaseTarget(target)}. ` +
        'Set it in the shell for this command, e.g. DATABASE_URL="<production DIRECT_URL>" pnpm db:reconcile-returns. ' +
        "The repo .env is deliberately not read.",
    };
  }
  return {
    kind: "allowed",
    url: env.DATABASE_URL as string,
    message: `reconcile-returns: writing to ${describeDatabaseTarget(target)}`,
  };
}
