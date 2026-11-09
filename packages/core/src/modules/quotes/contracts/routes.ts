/**
 * The quotes routes' own schemas: the vehicle path param and the empty refusal body.
 * Server-only — not part of the web contract (`http.ts`), which is why they moved out
 * of it in 5.1d. Customers carries the same two lines in its own `routes.ts`.
 */
import { z } from "zod";

/** Path `{ id }` for a vehicle. */
export const vehicleIdParams = z.object({ id: z.string().min(1) });

/**
 * The body of a 404 (and a 400 from these routes): empty, so the answer confirms
 * nothing about a vehicle outside the caller's unit.
 */
export const notFoundBody = z.object({});
