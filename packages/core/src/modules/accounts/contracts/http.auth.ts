/**
 * Zod contracts for session identity and user-administration request bodies.
 *
 * Moved from `packages/shared-types/src/auth.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

const unitIdSchema = z.string().min(1);

/** Response body for `GET /me` with the signed-in user and their unit memberships. */
export const meSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1),
  unitIds: z.array(unitIdSchema),
  currentUnitId: unitIdSchema.optional(),
});

/** Request body for creating a new CRM user with optional initial unit assignments. */
export const createUserBodySchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unitIds: z.array(unitIdSchema).optional(),
});

/** Request body for replacing the full set of units assigned to a user. */
export const attachUnitsBodySchema = z.object({
  unitIds: z.array(unitIdSchema),
});

/** Signed-in user payload from `GET /me` with unit memberships. */
export type Me = z.infer<typeof meSchema>;

/** Request body for creating a new CRM user with optional initial unit assignments. */
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/** Request body for replacing the full set of units assigned to a user. */
export type AttachUnitsBody = z.infer<typeof attachUnitsBodySchema>;
