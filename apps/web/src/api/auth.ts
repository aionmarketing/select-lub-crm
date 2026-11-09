/**
 * Session and user-admin HTTP.
 */
import {
  meSchema,
  teamUserListSchema,
  unitListSchema,
  type CreateUserBody,
  type Me,
  type TeamUser,
  type Unit,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Returns the signed-in user profile and unit memberships.
 * @returns Parsed `Me` from `GET /auth/me`.
 */
export async function fetchMe(): Promise<Me> {
  const body = await parse(await apiRead(`${apiBase}/auth/me`));
  return meSchema.parse(body);
}

/**
 * Provisions a new CRM user account.
 * @param input - Email, password, display name, and optional initial unit ids.
 * @returns Parsed `Me` for the created user from `POST /users`.
 */
export async function createUser(input: CreateUserBody): Promise<Me> {
  const body = await parse(
    await fetch(`${apiBase}/users`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return meSchema.parse(body);
}

/**
 * Replaces the store units attached to a user.
 * @param userId - Target user id used in the path segment.
 * @param unitIds - Full replacement list; an empty array removes all unit memberships.
 * @returns Parsed `Me` for the updated user from `PUT /users/:userId/units`.
 */
export async function attachUserUnits(userId: string, unitIds: string[]): Promise<Me> {
  const body = await parse(
    await fetch(`${apiBase}/users/${userId}/units`, {
      method: "PUT",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ unitIds }),
    }),
  );
  return meSchema.parse(body);
}

/**
 * Every unit the signed-in user may act on, each carrying its display name.
 *
 * The session store holds only `currentUnitId`, so this is the one place a
 * unit's NAME reaches the client. `name` is required by the contract, which is
 * what lets a screen promise never to fall back to showing an identifier.
 *
 * @returns The caller's units; an empty list when they hold none.
 */
export async function fetchUnits(): Promise<Unit[]> {
  return unitListSchema.parse(
    await parse(await apiRead(`${apiBase}/units`)),
  );
}

/**
 * The CRM users the signed-in caller may see, each with its unit memberships.
 *
 * Every row's `unitIds` is that user's COMPLETE membership set, including lojas
 * the caller does not hold. Callers must treat it as such: `attachUserUnits`
 * replaces the whole set, so saving a list narrowed to the caller's own lojas
 * would delete the memberships they never saw.
 *
 * @returns The visible team from `GET /users`; an empty list when the caller
 *   shares no loja with anyone else.
 */
export async function fetchUsers(): Promise<TeamUser[]> {
  return teamUserListSchema.parse(
    await parse(await apiRead(`${apiBase}/users`)),
  );
}
