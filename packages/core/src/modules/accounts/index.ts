/**
 * `accounts` — units, users, and the unit memberships that scope every other
 * module's reads. Owns `unit`, `user` and `user_unit` (`ownership.json`).
 *
 * The only file a composition root imports. It exports:
 *
 * - {@link createHttpPlugin}: the five routes, `GET /auth/me`, `GET /users`,
 *   `POST /users`, `PUT /users/:id/units` and `GET /units`. Their paths are
 *   unchanged from `apps/api`, and must stay so: the auth hook's
 *   `isUnitExemptPath` matches three of them by literal path, and a renamed
 *   path would silently start demanding `X-Unit-Id`.
 * - {@link createCallerDirectory}: the caller reads the authentication hook
 *   makes. The hook stays in `apps/api` for now (wave 2 correction W2-C1); what
 *   it reads, `user` and `user_unit`, is this module's.
 * - The identity provider's create-user port and its adapters, for the
 *   composition root to pick one and pass it in.
 *
 * The hook itself is not here and not in this module: it is cross-cutting, and
 * a module every other module had to import to be authenticated would make
 * accounts a dependency of all ten.
 */
import type { HttpPlugin } from "../../kernel/http.js";
import { registerSlice } from "../../kernel/http.js";
import { createRoute as createUserRoute } from "./create-user/index.js";
import { route as getMeRoute } from "./get-me/index.js";
import type { CreateAuthUser } from "./internal/create-auth-user.js";
import { route as listUnitsRoute } from "./list-units/index.js";
import { route as listUsersRoute } from "./list-users/index.js";
import { route as setUserUnitsRoute } from "./set-user-units/index.js";

/** What accounts needs from outside to serve its routes. */
export interface AccountsPorts {
  /** The identity provider's create-user call; `POST /users` uses it. */
  readonly createAuthUser: CreateAuthUser;
}

/**
 * Accounts' HTTP plugin, over the given ports.
 *
 * The ports live in this closure, one per app, never in a module-level
 * variable: two apps built side by side — every test builds its own — must not
 * share a provider.
 *
 * @param ports - See {@link AccountsPorts}.
 * @returns The plugin that registers accounts' five slices.
 */
export function createHttpPlugin(ports: AccountsPorts): HttpPlugin {
  return (app) => {
    registerSlice(app, "accounts", "get-me", getMeRoute);
    registerSlice(app, "accounts", "list-users", listUsersRoute);
    registerSlice(app, "accounts", "list-units", listUnitsRoute);
    registerSlice(app, "accounts", "set-user-units", setUserUnitsRoute);
    registerSlice(app, "accounts", "create-user", createUserRoute(ports));
  };
}

export {
  createCallerDirectory,
  type Caller,
  type CallerDirectory,
  type CrmUser,
} from "./internal/directory.js";
export {
  createFakeCreateAuthUser,
  createSupabaseCreateAuthUser,
  SERVICE_ROLE_ENV,
  type CreateAuthUser,
} from "./internal/create-auth-user.js";
