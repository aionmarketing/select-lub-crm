/**
 * Zod contracts for the Usuários screen's read surface: the team list and the
 * units a caller may act on.
 *
 * Separate from `auth.ts` on purpose. `auth.ts` describes the caller's own
 * session; these describe other people and the rows the caller is allowed to
 * pick from, and the two move for different reasons.
 *
 * Neither schema has a field for a password, an Auth service-role key or a
 * session token, and Zod strips what it does not name — so the response
 * serializer drops such a field even if a store ever handed one over.
 *
 * Moved from `packages/shared-types/src/team.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

const id = z.string().min(1);

/**
 * One CRM user as the Usuários team list shows them.
 *
 * `unitIds` is the user's COMPLETE membership set, including units the caller
 * cannot see. Filtering it to the caller's own units would be a data-loss trap:
 * `PUT /users/:id/units` replaces the whole set, so the next save from a
 * filtered list would silently drop every membership the caller never saw.
 */
export const teamUserSchema = z.object({
  id,
  email: z.string().min(1),
  name: z.string().min(1),
  unitIds: z.array(id),
});

/** Response body for `GET /users`. */
export const teamUserListSchema = z.array(teamUserSchema);

/**
 * One unit the caller may act on, carrying the name the screen shows.
 *
 * `name` is required rather than optional because the point of this read is to
 * stop the operator working from identifiers: a row without a name would put
 * the id back on screen.
 */
export const unitSchema = z.object({
  id,
  name: z.string().min(1),
});

/** Response body for `GET /units`. */
export const unitListSchema = z.array(unitSchema);

/** One CRM user as the Usuários team list shows them. */
export type TeamUser = z.infer<typeof teamUserSchema>;

/** One unit the caller may act on, carrying the name the screen shows. */
export type Unit = z.infer<typeof unitSchema>;
