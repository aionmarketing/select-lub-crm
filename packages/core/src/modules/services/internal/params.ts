/**
 * Path parameters and the empty error body the services routes share.
 *
 * Copies of `apps/api/src/http/schemas.ts`'s `customerIdParams`,
 * `vehicleIdParams`, `conversationIdParams` and `notFoundBody`, and of the
 * inline `/services/:id` params, which a module may not import. All four id
 * params were the same zod shape, so one stands for them: a request the api
 * accepted is still accepted, and every 404 body is still `{}`.
 */
import { z } from "zod";

/** `{}` — the body of every services 404. */
export const notFoundBody = z.object({});

/** `/:id` — a customer, a vehicle, a conversation or a service, by its own id. */
export const idParams = z.object({ id: z.string().min(1) });
